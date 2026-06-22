import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCompany, matchInvestee } from './investee-match';

test('normalizeCompany strips legal suffixes, punctuation, diacritics', () => {
  assert.equal(normalizeCompany('Gamivo S.A.'), 'gamivo');
  assert.equal(normalizeCompany('RemoteMyApp sp. z o.o.'), 'remotemyapp');
  assert.equal(normalizeCompany('RUBICON VENTURE LIMITED'), 'rubicon venture');
  assert.equal(normalizeCompany('Woodpecker.co Sp. z o.o.'), 'woodpecker');
});

const roster = [
  { name: 'Gamivo S.A.', controlCode: '030-gc' },
  { name: 'Rubicon Venture shares', controlCode: '030-rv' },
  { name: 'Woodpecker.co Joint Stock', controlCode: '030-wp' },
  { name: 'Beta Bioscience Ltd', controlCode: '032-beta' },
];

test('matches a registry-extract company name to its holding', () => {
  assert.equal(matchInvestee('Gamivo S.A.', roster)?.controlCode, '030-gc');
  assert.equal(matchInvestee('GAMIVO SA', roster)?.controlCode, '030-gc');
  assert.equal(matchInvestee('RUBICON VENTURE LIMITED', roster)?.controlCode, '030-rv');
  assert.equal(matchInvestee('Woodpecker.co sp. z o.o.', roster)?.controlCode, '030-wp');
});

test('returns null when no holding plausibly matches', () => {
  assert.equal(matchInvestee('Acme Robotics Sp. z o.o.', roster), null);
  assert.equal(matchInvestee('', roster), null);
  assert.equal(matchInvestee(null, roster), null);
  assert.equal(matchInvestee('AB', roster), null); // too short
});

test('an exact name match wins', () => {
  const r = [
    { name: 'Nimbus', controlCode: '030-a' },
    { name: 'Nimbus Cloud Holdings', controlCode: '030-b' },
  ];
  assert.equal(matchInvestee('Nimbus Cloud Holdings Ltd', r)?.controlCode, '030-b');
});

test('a share registry extract prefers the equity (030) holding over the loan (032)', () => {
  const r = [
    { name: 'Rubicon Venture shares', controlCode: '030-rv' },
    { name: 'Loans granted to Rubicon Venture Limited', controlCode: '032-rv' },
  ];
  assert.equal(matchInvestee('RUBICON VENTURE LIMITED', r)?.controlCode, '030-rv');
});
