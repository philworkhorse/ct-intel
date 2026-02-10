#!/usr/bin/env node
// Bundle CT scan data into a single JSON file for deployment
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.env.HOME || '/root', 'ct-scanner/data');
const OUT = path.join(__dirname, 'scans-bundle.json');

const files = fs.readdirSync(DATA_DIR)
  .filter(f => f.endsWith('.json'))
  .sort();

const scans = [];
let errors = 0;

for (const f of files) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f)));
    scans.push(data);
  } catch (e) {
    errors++;
  }
}

fs.writeFileSync(OUT, JSON.stringify(scans));
console.log(`Bundled ${scans.length} scans (${errors} errors) → ${OUT}`);
console.log(`Size: ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)}MB`);
