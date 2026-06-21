import test from 'node:test';
import assert from 'node:assert/strict';
import { isNonPostable, isHardNonPostable } from './process';

test('rejects non-accounting / statutory documents (the reject list)', () => {
  const reject = [
    ['Audited financial statements', '2022-10-08-THCP MT -FS 2020 (1).pdf'],
    ['', 'F2B1 - RUBICON VENTURE LIMITED (C 94936) - Malta Business Registry extract.pdf'],
    ['company registry extract', 'F2B2 - Gamivo S.A.pdf'],
    ['Memorandum of Association', 'M&A_J23_S.A.pdf'],
    ['Cash confirmation', 'K2A1 - Cash confirmation - 2021.docx'],
    ['bank balance confirmation', 'DM Santander confirmation.pdf'],
    ['KYC document', 'passport.pdf'],
    ['engagement letter', 'engagement.pdf'],
  ];
  for (const [dt, fn] of reject) {
    assert.equal(isNonPostable(dt, fn), true, `should reject: ${dt} ${fn}`);
  }
});

test('does NOT reject genuine transactional documents', () => {
  const keep = [
    ['Share purchase agreement', 'J2C2 - 20210423_SPA_Kozlowski_THCP MT_Booste.pdf'],
    ['loan agreement', 'F2D1 - 20210225_ J23 S.A._Umowa pozyczki_THCP MT.pdf'],
    ['invoice', 'J2C6 - Invoice INV-2471 Ormco.pdf'],
    ['bank statement', 'Santander BS 2021 THCP MT.pdf'],
  ];
  for (const [dt, fn] of keep) {
    assert.equal(isNonPostable(dt, fn), false, `should keep: ${dt} ${fn}`);
  }
});

test('hard-rejects registry extracts & risk assessments even when the AI misreads them', () => {
  // Folder-based: a person registry extract the model mistook for a share disposal.
  assert.equal(isHardNonPostable('F2B1.13 - Radoslaw Zorawicz.pdf', 'EXTRACTS FROM THE REGISTER OF COMPANIES/J23 S.A'), true);
  // Business risk assessment routed into review as a journal.
  assert.equal(isHardNonPostable('BRA Tar Heel Capital Patfinder Limited 2020.pdf', 'BRA'), true);
  assert.equal(isHardNonPostable('BRA Summary Tar Heel Capital Patfinder Limited 2020.pdf', 'BRA'), true);
  // F2B filename prefix even without folder context.
  assert.equal(isHardNonPostable('F2B1.16 - Grzegorz Andreasik June.pdf', ''), true);
  // And isNonPostable now catches them too (with documentType the AI guessed).
  assert.equal(isNonPostable('share transfer', 'F2B1.14 - Damian Lilla June.pdf', 'EXTRACTS FROM THE REGISTER OF COMPANIES/GAMIVO S.A'), true);

  // A genuine SPA carrying an F2B prefix must still be processed (transactional
  // signal overrides the filename reject).
  assert.equal(isHardNonPostable('F2B1.32 - Carpathia_20210707 SPA_Woodpecker.pdf', ''), false);
  // Must NOT reject genuine deal docs sitting in accounting folders.
  assert.equal(isHardNonPostable('20220816_SPA_THCP MT_DS_Responsiblee en-pl.pdf', 'SHARES/PURCHASE'), false);
  assert.equal(isHardNonPostable('20210730_Receivables Sale Agreement.pdf', 'AD5'), false);
  assert.equal(isHardNonPostable('2021 Bendura.pdf', 'Bank Statements/Bendura'), false);
});
