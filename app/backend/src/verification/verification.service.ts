import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '../prisma/prisma.service';
import { ClaimStatus, Prisma } from '@prisma/client';
import { CreateVerificationDto } from './dto/create-verification.dto';
import {
  ReviewQueuePaginationMode,
  ReviewQueueQueryDto,
} from './dto/review-queue-query.dto';
import {
  VerificationJobData,
  VerificationResult,
} from './interfaces/verification-job.interface';
import { AuditService } from '../audit/audit.service';
import { firstValueFrom } from 'rxjs';
import OpenAI from 'openai';
import * as crypto from 'crypto';
import { CircuitBreaker } from '../common/utils/circuit-breaker.util';
import { VerificationMetadataService } from './metadata.service';
import { VerificationResultDto } from './dto/verification-result.dto';
import { CorrelationPropagationUtil } from '../common/utils/correlation-propagation.util';

// ---------------------------------------------------------------------------
// OCR service types
// ---------------------------------------------------------------------------

interface OCRFieldResult {
  value: string;
  confidence: number;
}

interface OCRResponse {
  success: boolean;
  data?: {
    fields: Record<string, OCRFieldResult>;
    raw_text: string;
    processing_time_ms: number;
  };
  error?: Record<string, string>;
  processing_time_ms: number;
}

// ---------------------------------------------------------------------------
// Internal claim shape used by verification logic
// ---------------------------------------------------------------------------

interface Claim {
  id: string;
  status: string;
  campaignId: string;
  amount: unknown;
  recipientRef: string;
  evidenceRef?: string | null;
}

// ---------------------------------------------------------------------------
// Structured JSON that the AI model must return
// ---------------------------------------------------------------------------

interface AIVerificationResponse {
  score: number; // 0–1 normalised legitimacy score
  confidence: number; // 0–1 model confidence
  riskLevel: 'low' | 'medium' | 'high';
  factors: string[]; // positive verification signals
  riskFactors: string[]; // identified concerns / red-flags
  recommendations: string[]; // next steps if human review needed
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type ReviewQueueCursorPayload = {
  createdAt: string;
  id: string;
};

const reviewQueueClaimArgs = {
  include: {
    campaign: {
      select: {
        id: true,
        name: true,
        status: true,
        archivedAt: true,
      },
    },
  },
} satisfies Prisma.ClaimDefaultArgs;

type ReviewQueueItem = Prisma.ClaimGetPayload<typeof reviewQueueClaimArgs>;

type ReviewQueueResponse = {
  items: ReviewQueueItem[];
  pagination:
    | {
        mode: 'page';
        page: number;
        limit: number;
        totalItems: number;
        totalPages: number;
        hasNextPage: boolean;
      }
    | {
        mode: 'cursor';
        limit: number;
        nextCursor: string | null;
        hasNextPage: boolean;
      };
  filters: {
    status?: ClaimStatus[];
    campaignId?: string;
    fromDate?: string;
    toDate?: string;
  };
};

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  private readonly verificationMode: string;
  private readonly verificationThreshold: number;
  private readonly aiServiceUrl: string;
  private readonly aiServiceTimeout: number;
  private readonly openaiModel: string;
  private readonly openai: OpenAI | null;
  private readonly ocrCircuitBreaker: CircuitBreaker;
  private readonly llmCircuitBreaker: CircuitBreaker;

  constructor(
    @InjectQueue('verification') private verificationQueue: Queue,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly httpService: HttpService,
    private readonly verificationMetadataService: VerificationMetadataService,
    private readonly correlationUtil: CorrelationPropagationUtil,
  ) {
    this.verificationMode =
      this.configService.get<string>('VERIFICATION_MODE') || 'mock';
    this.verificationThreshold =
      parseFloat(
        this.configService.get<string>('VERIFICATION_THRESHOLD') || '0.7',
      ) || 0.7;
    this.aiServiceUrl =
      this.configService.get<string>('AI_SERVICE_URL') ||
      'http://localhost:8000';
    this.aiServiceTimeout = parseInt(
      this.configService.get<string>('AI_SERVICE_TIMEOUT_MS') || '30000',
      10,
    );
    this.openaiModel =
      this.configService.get<string>('OPENAI_MODEL') || 'gpt-4o-mini';

    // Initialise OpenAI client only when a key is present.
    // A missing key is not fatal – the fallback path handles it gracefully.
    const openAIKey = this.configService.get<string>('OPENAI_API_KEY');
    if (openAIKey) {
      this.openai = new OpenAI({ apiKey: openAIKey });
      this.logger.log(`OpenAI client initialised (model: ${this.openaiModel})`);
    } else {
      this.openai = null;
      this.logger.warn(
        'OPENAI_API_KEY not set – AI verification will fall back to mock scoring',
      );
    }

    this.ocrCircuitBreaker = new CircuitBreaker({
      failureThreshold: parseInt(
        this.configService.get<string>('OCR_CIRCUIT_BREAKER_THRESHOLD') || '3',
        10,
      ),
      resetTimeout: parseInt(
        this.configService.get<string>('OCR_CIRCUIT_BREAKER_RESET_TIMEOUT') ||
          '30000',
        10,
      ),
    });
    this.llmCircuitBreaker = new CircuitBreaker({
      failureThreshold: parseInt(
        this.configService.get<string>('LLM_CIRCUIT_BREAKER_THRESHOLD') || '3',
        10,
      ),
      resetTimeout: parseInt(
        this.configService.get<string>('LLM_CIRCUIT_BREAKER_RESET_TIMEOUT') ||
          '30000',
        10,
      ),
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async enqueueVerification(
    claimId: string,
    anchorMetadata?: {
      campaignRef?: string;
      claimId?: string;
      packageId?: string;
    },
  ): Promise<{ jobId: string }> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
    });

    if (!claim) {
      throw new NotFoundException(`Claim with ID ${claimId} not found`);
    }

    if (claim.status === 'verified') {
      this.logger.warn(`Claim ${claimId} is already verified`);
      return { jobId: 'already-verified' };
    }

    const jobData: VerificationJobData = {
      claimId,
      timestamp: Date.now(),
      anchorMetadata: anchorMetadata
        ? {
            campaignRef: anchorMetadata.campaignRef ?? null,
            claimId: anchorMetadata.claimId ?? null,
            packageId: anchorMetadata.packageId ?? null,
          }
        : undefined,
    };

    const job = await this.verificationQueue.add('verify-claim', jobData, {
      attempts: parseInt(
        this.configService.get<string>('QUEUE_MAX_RETRIES') || '3',
      ),
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    });

    this.logger.log(`Enqueued verification job ${job.id} for claim ${claimId}`);

    await this.auditService.record({
      actorId: 'system',
      entity: 'verification',
      entityId: claimId,
      action: 'enqueue',
      metadata: { jobId: job.id || 'unknown', anchorMetadata },
    });

    return { jobId: job.id || 'unknown' };
  }

  async processVerification(
    jobData: VerificationJobData,
  ): Promise<VerificationResult> {
    const { claimId, anchorMetadata } = jobData;

    this.logger.log(
      `Processing verification for claim ${claimId} in ${this.verificationMode} mode`,
    );

    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
    });

    if (!claim) {
      throw new NotFoundException(`Claim with ID ${claimId} not found`);
    }

    let result: VerificationResult;

    if (this.verificationMode === 'test') {
      result = this.generateTestVerification(claim);
    } else if (this.verificationMode === 'mock') {
      result = this.generateMockVerification(claim);
    } else {
      result = await this.performAIVerification(claim);
    }

    // ENHANCED: Add contract-aware metadata to result
    const enhancedResult = await this.enhanceResultWithMetadata(
      result,
      claimId,
      claim.campaignId,
    );

    const shouldVerify = enhancedResult.score >= this.verificationThreshold;

    // Build anchor metadata to persist
    const anchorMetadataToPersist = anchorMetadata
      ? {
          campaignRef: anchorMetadata.campaignRef ?? null,
          claimId: anchorMetadata.claimId ?? null,
          packageId: anchorMetadata.packageId ?? null,
        }
      : null;

  