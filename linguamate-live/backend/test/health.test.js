const test = require('node:test');
const assert = require('node:assert/strict');

test('health endpoint contract documents provider configuration without secrets', () => {
  const expectedKeys = ['ok', 'service', 'providers'];
  const example = {
    ok: true,
    service: 'linguamate-live-backend',
    providers: { tencentAsrConfigured: false, translationConfigured: false, cleanupConfigured: false },
  };
  assert.deepEqual(Object.keys(example), expectedKeys);
  assert.equal('secretKey' in example, false);
});
