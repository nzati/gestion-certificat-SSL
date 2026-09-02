#!/usr/bin/env node
'use strict';

/**
 * Vérifie l'expiration d'un nom de domaine via RDAP (gratuit, sans clé).
 * Sert de référence pour le module HTTP + Itérateur/Filtre à construire
 * dans Make (scénario A, étape 4) — voir docs/cahier-des-charges-technique.md.
 *
 * Usage : node scripts/test-rdap.js exemple.fr
 */

async function checkDomain(domain) {
  const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
    // Certains registres (ex. Verisign, derrière rdap.org) renvoient 403 au
    // User-Agent par défaut des clients HTTP "machine" (fetch de Node, et
    // probablement le module HTTP de Make) — un User-Agent de navigateur ou
    // de curl passe sans problème.
    headers: { Accept: 'application/rdap+json', 'User-Agent': 'curl/8.21.0' },
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 404 && body.title === 'No RDAP service is available for this resource') {
    return { domain, error: 'pas de service RDAP pour ce TLD (registre non couvert)' };
  }
  if (!res.ok) {
    return { domain, error: `RDAP a répondu ${res.status}` };
  }

  const expiration = (body.events || []).find((e) => e.eventAction === 'expiration');
  const registrarEntity = (body.entities || []).find((e) => (e.roles || []).includes('registrar'));
  const registrarField =
    registrarEntity &&
    registrarEntity.vcardArray &&
    registrarEntity.vcardArray[1] &&
    registrarEntity.vcardArray[1].find((f) => f[0] === 'fn');

  return {
    domain,
    expires_at: expiration ? expiration.eventDate : null,
    registrar: registrarField ? registrarField[3] : null,
    error: expiration ? null : "pas d'événement 'expiration' dans la réponse RDAP",
  };
}

const domain = process.argv[2];
if (!domain) {
  console.error('Usage : node scripts/test-rdap.js <domaine>');
  process.exit(1);
}

checkDomain(domain).then((info) => console.log(JSON.stringify(info, null, 2)));
