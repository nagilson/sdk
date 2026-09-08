export function matchesFailure(current, previous)
{
  return current.phase === previous.phase && current.failureType === previous.failureType
    && ((current.fingerprint && current.fingerprint === previous.fingerprint)
      || (current.failureFamilyFingerprint && current.failureFamilyFingerprint === previous.failureFamilyFingerprint)
      || (current.kind === "test" && current.component === previous.component
        && current.mechanismFingerprint && current.mechanismFingerprint === previous.mechanismFingerprint));
}
