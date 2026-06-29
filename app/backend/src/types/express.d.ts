import { AppRole } from '../auth/app-role.enum';
import { ApiKeyScope } from '../api-keys/api-key-scope.enum';

declare global {
  namespace Express {
    interface Request {
      user?: {
        role: AppRole;
        ngoId?: string | null;
        apiKeyId?: string;
        authType?: 'apiKey' | 'envApiKey';
        scopes?: ApiKeyScope[];
      };
    }
  }
}
