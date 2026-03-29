/**
 * Automatic OAuth token refresh for Claude Code.
 *
 * Reads the refresh token from ~/.claude/.credentials.json,
 * exchanges it for a new access token via the Anthropic OAuth endpoint,
 * and updates both the credentials file and .env.
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Refresh 15 minutes before expiry to avoid race conditions. */
const REFRESH_BUFFER_MS = 15 * 60 * 1000;

/** Check token expiry every 5 minutes. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface CredentialsFile {
  claudeAiOauth?: OAuthCredentials;
}

let refreshTimer: ReturnType<typeof setInterval> | undefined;

function getCredentialsPath(): string {
  return path.join(process.env.HOME || '/root', '.claude', '.credentials.json');
}

function readCredentials(): CredentialsFile | null {
  try {
    return JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf-8'));
  } catch {
    return null;
  }
}

function writeCredentials(creds: CredentialsFile): void {
  const credPath = getCredentialsPath();
  fs.mkdirSync(path.dirname(credPath), { recursive: true });
  fs.writeFileSync(credPath, JSON.stringify(creds, null, 2));
}

/**
 * Update the CLAUDE_CODE_OAUTH_TOKEN in .env and data/env/env.
 */
function updateEnvToken(newToken: string): void {
  const envPath = path.join(process.cwd(), '.env');
  try {
    let content = fs.readFileSync(envPath, 'utf-8');
    content = content.replace(
      /^CLAUDE_CODE_OAUTH_TOKEN=.*/m,
      `CLAUDE_CODE_OAUTH_TOKEN=${newToken}`,
    );
    fs.writeFileSync(envPath, content);

    // Sync to container env
    const dataEnvDir = path.join(process.cwd(), 'data', 'env');
    fs.mkdirSync(dataEnvDir, { recursive: true });
    fs.copyFileSync(envPath, path.join(dataEnvDir, 'env'));
  } catch (err) {
    logger.warn({ err }, 'Failed to update .env with refreshed token');
  }
}

/**
 * Exchange a refresh token for a new access token.
 */
async function exchangeRefreshToken(
  refreshToken: string,
): Promise<OAuthCredentials | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error(
        { status: response.status, body },
        'OAuth token refresh failed',
      );
      return null;
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  } catch (err) {
    logger.error({ err }, 'OAuth token refresh request failed');
    return null;
  }
}

/**
 * Check if the token needs refreshing and refresh it if so.
 * Returns true if the token is valid (either already valid or successfully refreshed).
 */
export async function ensureValidToken(): Promise<boolean> {
  const creds = readCredentials();
  const oauth = creds?.claudeAiOauth;

  if (!oauth?.refreshToken) {
    logger.debug('No OAuth refresh token available, skipping auto-refresh');
    return !!oauth?.accessToken;
  }

  const now = Date.now();
  const timeUntilExpiry = oauth.expiresAt - now;

  if (timeUntilExpiry > REFRESH_BUFFER_MS) {
    return true; // Token still valid
  }

  logger.info(
    { expiresIn: Math.round(timeUntilExpiry / 1000) },
    'OAuth token expiring soon, refreshing...',
  );

  const newOAuth = await exchangeRefreshToken(oauth.refreshToken);
  if (!newOAuth) return false;

  // Preserve existing fields (scopes, subscriptionType, etc.)
  const updated: OAuthCredentials = {
    ...oauth,
    accessToken: newOAuth.accessToken,
    refreshToken: newOAuth.refreshToken,
    expiresAt: newOAuth.expiresAt,
  };

  // Write updated credentials
  writeCredentials({ ...creds, claudeAiOauth: updated });
  updateEnvToken(newOAuth.accessToken);

  logger.info(
    { expiresAt: new Date(newOAuth.expiresAt).toISOString() },
    'OAuth token refreshed successfully',
  );

  return true;
}

/**
 * Start a background timer that periodically checks and refreshes the token.
 * Call this once at startup.
 */
export function startTokenRefreshLoop(): void {
  if (refreshTimer) return;

  // Initial check
  ensureValidToken().catch((err) =>
    logger.error({ err }, 'Initial token refresh check failed'),
  );

  refreshTimer = setInterval(() => {
    ensureValidToken().catch((err) =>
      logger.error({ err }, 'Periodic token refresh check failed'),
    );
  }, CHECK_INTERVAL_MS);

  // Don't block process exit
  refreshTimer.unref();
  logger.info('OAuth token auto-refresh started (checking every 5 min)');
}

/**
 * Stop the background refresh timer.
 */
export function stopTokenRefreshLoop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}
