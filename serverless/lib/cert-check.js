'use strict';

const tls = require('tls');
const net = require('net');

const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const BLOCKED_HOSTS = new Set(['localhost']);

/** Rejette les IP littérales, localhost et .local — protection SSRF minimale. */
function isValidDomain(domain) {
  if (!domain || domain.length > 253) return false;
  if (net.isIP(domain)) return false;
  const lower = domain.toLowerCase();
  if (BLOCKED_HOSTS.has(lower) || lower.endsWith('.local')) return false;
  return DOMAIN_PATTERN.test(domain);
}

/** Ouvre une connexion TLS et lit le certificat présenté par le serveur. */
function getCertInfo(domain, { port = 443, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: domain,
        port,
        servername: domain, // SNI — indispensable pour les domaines mutualisés
        timeout: timeoutMs,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();

        if (!cert || Object.keys(cert).length === 0) {
          reject(new Error('aucun certificat reçu'));
          return;
        }

        resolve({
          domain,
          expires_at: new Date(cert.valid_to).toISOString(),
          issued_at: new Date(cert.valid_from).toISOString(),
          issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'inconnu',
          subject: cert.subject && cert.subject.CN,
          checked_at: new Date().toISOString(),
        });
      },
    );

    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('délai de connexion dépassé'));
    });

    socket.once('error', (err) => {
      reject(new Error(err.code || err.message));
    });
  });
}

module.exports = { isValidDomain, getCertInfo };
