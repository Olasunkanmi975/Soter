import { AppRole } from '../auth/app-role.enum';

declare global {
  namespace Express {
    interface Request {
      user?: {
        role: AppRole;
        id?: string;
        ngoId?: string | null;
        orgId?: string | null;
        apiKeyId?: string;
        authType?: 'apiKey' | 'envApiKey';
      };
    }
  }
}
