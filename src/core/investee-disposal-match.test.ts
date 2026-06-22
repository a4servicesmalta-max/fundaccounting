// Regression for a real Mode-A bug: a DISPOSAL minted a FRESH control code from
// the investee name (`030-${slug(name)}`) instead of resolving to the EXISTING
// holding the opening balance registered. So a sale of "Booste Spółka Akcyjna"
// looked for carrying cost under `030-booste-spolka-akcyjna` while the holding
// lived under `030-BSA` ("Booste S.A.") → carrying 0 → the whole proceeds booked
// as gain and the position never came off the books.
//
// Two gaps to close:
//  1. matchInvestee didn't strip the spelled-out Polish legal forms ("Spółka
//     Akcyjna", "Spółka z o.o."), so "Booste Spółka Akcyjna" ≠ "Booste S.A.".
//  2. there was no instrument-prefix-aware resolver to map an event's investee
//     to an existing 030 (equity) / 032 (loan) holding before minting a new code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchInvestee, findExistingHolding } from './investee-match';

test('matchInvestee strips the spelled-out Polish legal form (Spółka Akcyjna)', () => {
  const roster = [{ name: 'Booste S.A.', controlCode: '030-booste' }];
  const m = matchInvestee('Booste Spółka Akcyjna', roster);
  assert.equal(m?.controlCode, '030-booste');
});

test('matchInvestee strips Spółka z o.o.', () => {
  const roster = [{ name: 'Plum Research Sp. z o.o.', controlCode: '032-plum' }];
  const m = matchInvestee('Plum Research Spółka z ograniczoną odpowiedzialnością', roster);
  assert.equal(m?.controlCode, '032-plum');
});

test('findExistingHolding resolves a disposal to the opening holding despite an abbreviated code', () => {
  // Opening registered the holding under an abbreviation, with the friendly name.
  const roster = [{ name: 'Booste S.A.', controlCode: '030-BSA' }];
  const hit = findExistingHolding('Booste Spółka Akcyjna', '030', roster);
  assert.equal(hit?.controlCode, '030-BSA', 'disposal must reuse the existing holding, not mint 030-booste-spolka-akcyjna');
});

test('findExistingHolding is instrument-prefix aware (equity vs loan)', () => {
  const roster = [
    { name: 'Booste S.A.', controlCode: '030-booste' }, // equity
    { name: 'Booste S.A.', controlCode: '032-booste' }, // loan
  ];
  assert.equal(findExistingHolding('Booste S.A.', '030', roster)?.controlCode, '030-booste');
  assert.equal(findExistingHolding('Booste S.A.', '032', roster)?.controlCode, '032-booste');
});

test('findExistingHolding returns null for a genuinely new investee (caller mints a fresh code)', () => {
  const roster = [{ name: 'Booste S.A.', controlCode: '030-booste' }];
  assert.equal(findExistingHolding('Brand New Ventures Ltd', '030', roster), null);
});
