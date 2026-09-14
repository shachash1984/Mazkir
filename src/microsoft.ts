import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-node';
import type { Config } from './config.js';
import { POLICY, InterventionError, RetryableError, UserError } from './config.js';
import { Store } from './store.js';
import type { CalendarEvent } from './domain.js';

export class MicrosoftAuth {
  private app: PublicClientApplication;
  constructor(private cfg: Config, private store: Store) {
    if (!cfg.msClientId || !cfg.organizerEmail) throw new InterventionError('Set MS_CLIENT_ID and ORGANIZER_EMAIL, then run login:microsoft.');
    this.app = new PublicClientApplication({
      auth: { clientId: cfg.msClientId, authority: 'https://login.microsoftonline.com/consumers' },
      cache: { cachePlugin: {
        beforeCacheAccess: async ctx => { const cache = store.get<string>('msal'); if (cache) ctx.tokenCache.deserialize(cache); },
        afterCacheAccess: async ctx => { if (ctx.cacheHasChanged) store.set('msal', ctx.tokenCache.serialize()); },
      } },
    });
  }
  async login(show: (message: string) => void): Promise<void> {
    const result = await this.app.acquireTokenByDeviceCode({ scopes: [...POLICY.scopes, 'offline_access'], deviceCodeCallback: code => show(code.message) });
    if (!result?.account || result.account.username.toLowerCase() !== this.cfg.organizerEmail) {
      if (result?.account) await this.app.getTokenCache().removeAccount(result.account);
      throw new InterventionError('Sign in using the configured organizer account, not a work or different personal account.');
    }
    this.store.set('ms-account', result.account.homeAccountId);
  }
  async token(forceRefresh = false): Promise<string> {
    const account = (await this.app.getTokenCache().getAllAccounts()).find(a =>
      a.homeAccountId === this.store.get<string>('ms-account') && a.username.toLowerCase() === this.cfg.organizerEmail);
    if (!account) throw new InterventionError('Microsoft organizer login is required. Run login:microsoft.');
    try {
      const result = await this.app.acquireTokenSilent({ account, scopes: [...POLICY.scopes], forceRefresh });
      if (!result?.accessToken) throw new InterventionError('Microsoft returned no access token.');
      return result.accessToken;
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) throw new InterventionError('Microsoft requires a new organizer sign-in.');
      throw e;
    }
  }
}

export interface GraphPort {
  request<T>(method: string, path: string, body?: unknown, etag?: string): Promise<T>;
  all<T>(path: string): Promise<T[]>;
}
export class GraphClient implements GraphPort {
  constructor(private auth: MicrosoftAuth) {}
  async request<T>(method: string, path: string, body?: unknown, etag?: string): Promise<T> {
    const url = path.startsWith('/') ? POLICY.graphBase + path : path;
    if (!url.startsWith(POLICY.graphBase + '/')) throw new Error('Unexpected Graph endpoint.');
    let response: Response;
    try {
      response = await fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(25000),
        headers: { Authorization: `Bearer ${await this.auth.token()}`, 'Content-Type': 'application/json',
          Prefer: `outlook.timezone="${POLICY.timezone}", IdType="ImmutableId"`, ...(etag ? { 'If-Match': etag } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) { if (e instanceof InterventionError) throw e; throw new RetryableError('Microsoft request could not complete.'); }
    if (response.status === 404) throw new NotFoundError();
    if (response.status === 401 || response.status === 403) throw new InterventionError('Microsoft access needs attention. Check organizer login and calendar permissions.');
    if (response.status === 429 || response.status >= 500) throw new RetryableError(`Microsoft is temporarily unavailable (${response.status}).`);
    if (response.status === 412) throw new UserError('This event changed while I was editing it. Please send your change again.', 'האירוע השתנה במהלך העריכה. נא לשלוח שוב את השינוי.');
    if (!response.ok) {
      const details = await response.json().catch(() => ({})) as { error?: { code?: string } };
      throw new UserError(`Microsoft rejected this change (${details.error?.code ?? response.status}). Please adjust the request.`, `מיקרוסופט דחתה את השינוי (${details.error?.code ?? response.status}). נא לשנות את הבקשה.`);
    }
    if (response.status === 204 || response.status === 202) return undefined as T;
    return await response.json() as T;
  }
  async all<T>(path: string): Promise<T[]> {
    const output: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next; page++) {
      if (page >= 100) throw new UserError('Please narrow the date range.', 'נא לצמצם את טווח התאריכים.');
      const result: { value: T[]; '@odata.nextLink'?: string } = await this.request('GET', next);
      output.push(...result.value);
      next = result['@odata.nextLink'];
    }
    return output;
  }
}
export class NotFoundError extends Error { constructor() { super('Calendar event no longer exists.'); } }
export const eventPath = (id: string): string => `/me/events/${encodeURIComponent(id)}`;
export const eventFields = 'id,subject,start,end,type,seriesMasterId,recurrence,categories,location,isCancelled,originalStart,organizer,attendees';
export async function getEvent(graph: GraphPort, id: string): Promise<CalendarEvent> {
  return graph.request('GET', `${eventPath(id)}?$select=${eventFields}`);
}
