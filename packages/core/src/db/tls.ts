import { isIP } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { DbError } from './errors.js';
import type { TlsMode } from '../domain/types.js';
import type { Endpoint } from './types.js';

export interface TlsSettings {
  mode: TlsMode;
  /** PEM bundle that replaces the system trust store when given. */
  caPem: string | null;
}

/**
 * TLS options for node-postgres. verify-full checks the chain and that the certificate names the
 * endpoint's servername; verify-ca checks the chain only; require encrypts without verifying
 * (shown as unverified everywhere); disable sends everything in clear text.
 */
export function postgresTls(settings: TlsSettings, endpoint: Endpoint) {
  const ca = settings.caPem ?? undefined;
  switch (settings.mode) {
    case 'disable':
      return false as const;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-ca':
      return { rejectUnauthorized: true, ca, checkServerIdentity: () => undefined };
    case 'verify-full':
      return {
        rejectUnauthorized: true,
        ca,
        // SNI carries host names only (RFC 6066); the identity check below still covers IP addresses.
        ...(isIP(endpoint.servername) ? {} : { servername: endpoint.servername }),
        checkServerIdentity: (_host: string, cert: PeerCertificate) =>
          checkServerIdentity(endpoint.servername, cert),
      };
  }
}

/** TLS options for mysql2, with the same meaning per mode. */
export function mysqlTls(settings: TlsSettings) {
  const ca = settings.caPem ?? undefined;
  switch (settings.mode) {
    case 'disable':
      return undefined;
    case 'require':
      return { rejectUnauthorized: false, verifyIdentity: false };
    case 'verify-ca':
      return { rejectUnauthorized: true, verifyIdentity: false, ...(ca ? { ca } : {}) };
    case 'verify-full':
      return { rejectUnauthorized: true, verifyIdentity: true, ...(ca ? { ca } : {}) };
  }
}

/** One-line description for connection tests and the UI. */
export function describeTls(mode: TlsMode, hasCa: boolean): string {
  switch (mode) {
    case 'disable':
      return 'Not encrypted';
    case 'require':
      return 'Encrypted, server identity not verified';
    case 'verify-ca':
      return `Encrypted, certificate chain verified${hasCa ? ' against the custom CA' : ''}; host name not checked`;
    case 'verify-full':
      return `Encrypted, certificate and host name verified${hasCa ? ' against the custom CA' : ''}`;
  }
}

/**
 * mysql2 checks certificate names only when the host is a DNS name; with an IP address it checks
 * against "localhost". verify-full therefore requires a host name for MySQL (verify-ca works with
 * an IP address). Returns the problem, or null.
 */
export function mysqlVerifyFullProblem(mode: TlsMode, host: string): DbError | null {
  if (mode !== 'verify-full' || !isIP(host)) return null;
  return new DbError(
    'tls',
    'TLS verify-full needs a host name for MySQL connections, not an IP address. Use the name in the server certificate, or verify-ca.',
    { code: 'VERIFY_FULL_NEEDS_HOSTNAME' },
  );
}
