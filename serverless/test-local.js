#!/usr/bin/env node
'use strict';

const { isValidDomain, getCertInfo } = require('./lib/cert-check');

const domain = process.argv[2];

if (!domain) {
  console.error('Usage : node test-local.js <domaine>');
  process.exit(1);
}

if (!isValidDomain(domain)) {
  console.error(`Domaine invalide : ${domain}`);
  process.exit(1);
}

getCertInfo(domain)
  .then((info) => {
    console.log(JSON.stringify(info, null, 2));
  })
  .catch((err) => {
    console.error(`Échec : ${err.message}`);
    process.exit(1);
  });
