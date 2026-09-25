// Versioned rule registry. A rule version is an immutable (sourceText, compute)
// pair; its digest is sha256 of the canonical source text, so an approval
// record can prove *which rule* was used even after the registry moves on.
import {createHash} from 'node:crypto';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function capRuleV1(input) {
  const amount = Number(input?.amount);
  if (!Number.isFinite(amount)) return null;
  return {value: {amount}, approves: amount <= 1000};
}

// Latest version is the default for new submissions; older entries are kept so
// historical evidence can always be replayed against the original rule.
export function createRuleRegistry() {
  const entries = [
    {
      ruleId: 'cap-rule',
      version: 1,
      description: 'Amount cap: amount <= 1000 auto-approved',
      sourceText: canonicalJson({
        ruleId: 'cap-rule',
        version: 1,
        formula: 'approves = isFiniteNumber(amount) && amount <= 1000',
      }),
      compute: capRuleV1,
    },
  ];
  for (const entry of entries) entry.digest = sha256(entry.sourceText);
  return {entries};
}

export function latestRule(registry) {
  return registry.entries.at(-1);
}

export function findRule(registry, ruleId, version) {
  return registry.entries.find((r) => r.ruleId === ruleId && r.version === version) || null;
}

// Tests (and future admin tooling) can register a new immutable version; the
// digest is derived, never supplied by the caller.
export function registerRule(registry, {ruleId, version, description, sourceText, compute}) {
  if (findRule(registry, ruleId, version)) throw new Error(`rule already registered: ${ruleId}@v${version}`);
  const entry = {
    ruleId,
    version,
    description: description ?? '',
    sourceText: typeof sourceText === 'string' ? sourceText : canonicalJson(sourceText),
    compute,
  };
  entry.digest = sha256(entry.sourceText);
  registry.entries.push(entry);
  return entry;
}
