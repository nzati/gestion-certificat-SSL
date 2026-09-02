'use strict';

const { isValidDomain, getCertInfo } = require('../lib/cert-check');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'méthode non autorisée' });
    return;
  }

  const apiKey = process.env.VIGIE_API_KEY;
  if (!apiKey || req.headers['x-vigie-key'] !== apiKey) {
    res.status(401).json({ error: 'non autorisé' });
    return;
  }

  const domain = String(req.query.domain || '').trim().toLowerCase();

  if (!isValidDomain(domain)) {
    res.status(400).json({ error: 'paramètre domain manquant ou invalide' });
    return;
  }

  try {
    const info = await getCertInfo(domain);
    res.status(200).json(info);
  } catch (err) {
    // Erreur "métier" (domaine injoignable, cert absent...) : 200 avec un
    // champ error, pour que le scénario Make distingue "vérifié, en échec"
    // d'une requête invalide (400) ou non autorisée (401).
    res.status(200).json({ domain, error: err.message, checked_at: new Date().toISOString() });
  }
};
