import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPartyName, partyKey } from './party';

test('extracts the party name before the account number / IBAN', () => {
  assert.equal(cleanPartyName('Bartosz Lis 20 1140 2004 0000 3602 5599 3961 Loan Agreement PRZELEW ELIXIR - IBIZNES24'), 'Bartosz Lis');
  assert.equal(cleanPartyName('Booste S.A. 10 1140 1137 0000 2639 3300 1001 Loan Agreement dated 15/11/2021 PRZELEW SORBNET - IBIZNES24'), 'Booste S.A.');
  assert.equal(cleanPartyName('J23 S.A. 62 1140 1137 0000 2942 2700 1001 Loan Agreement PRZELEW EXPRESS ELIXIR'), 'J23 S.A.');
  assert.equal(cleanPartyName('Sentryc GmbH DE 6910 0208 9000 2934 0250 Loan Agreement POLECENIE WYPŁATY WYCHODZĄCE'), 'Sentryc GmbH');
});

test('an already-clean name passes through unchanged', () => {
  assert.equal(cleanPartyName('Booste Spółka Akcyjna'), 'Booste Spółka Akcyjna');
  assert.equal(cleanPartyName('Gamivo Holdings Ltd'), 'Gamivo Holdings Ltd');
});

test('legal-suffix variants of the same party share a key', () => {
  assert.equal(partyKey('Booste S.A.'), partyKey('Booste Spółka Akcyjna'));
  assert.equal(partyKey('Booste S.A.'), 'booste');
  assert.equal(partyKey('J23 S.A.'), 'j23');
  assert.equal(partyKey('Sentryc GmbH'), 'sentryc');
  assert.equal(partyKey('Bartosz Lis'), 'bartosz lis');
});

test('distinct parties keep distinct keys', () => {
  assert.notEqual(partyKey('Booste S.A.'), partyKey('J23 S.A.'));
});
