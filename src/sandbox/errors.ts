export class SandboxUnavailableError extends Error {
  override readonly name = 'SandboxUnavailableError'
  constructor() {
    super(
      'sandbox unavailable: bwrap binary not found on PATH. Refusing to run a command that requires sandboxing without the kernel boundary in place.',
    )
  }
}

export class SandboxMaskTargetError extends Error {
  override readonly name = 'SandboxMaskTargetError'
  constructor(target: string, reason: string) {
    super(`sandbox canonical mask target is unsafe: ${target} (${reason}). Refusing to run model-driven bash.`)
  }
}

// Raised by the optional command-filter knobs (allowPrefixes,
// rejectShellMetacharacters). These are consumer-opt-in restrictions layered
// ABOVE the always-on kernel containment, so a rejection here is a policy
// decision the consumer asked for — not a failure of the sandbox itself. The
// message is phrased for the model to read and self-correct from.
export class SandboxPolicyError extends Error {
  override readonly name = 'SandboxPolicyError'
  constructor(reason: string) {
    super(`sandbox policy rejected command: ${reason}`)
  }
}

// Raised when model-driven bash invokes an agent-messenger CLI. TypeClaw never
// brokers those reusable auth profiles (resolvePrivilegedSandboxRuntime) AND
// masks the whole `workspace/.agent-messenger` directory, so the CLI can never
// authenticate here — every platform resolves credentials from a
// `<platform>-credentials.json` file, never from the environment.
//
// The refusal MUST announce itself. A silent one lets the uncredentialed CLI
// print its own "No current workspace set. Run `auth extract` first.", which the
// model reads as a fact about the WORLD — and it will then tell a human the
// runtime has no workspace authentication, laundering a local policy decision
// into a false claim about the upstream service. The CLI is honest about ITS
// state; it has no way to know it was deliberately deprived.
//
// Hence the message states its own provenance: what was withheld, that the
// decision is local, that retrying cannot help, and which mediated tool does
// work. The last part is load-bearing — a dead end the model cannot route
// around produces exactly the confabulation this class exists to prevent.
export class SandboxCredentialWithheldError extends Error {
  override readonly name = 'SandboxCredentialWithheldError'
  constructor(executable: string) {
    super(
      `credential withheld by TypeClaw policy: \`${executable}\` cannot authenticate in model-driven bash. ` +
        'TypeClaw never brokers an agent-messenger auth profile to a model-controlled child (the CLI can upload ' +
        'arbitrary files, so a brokered credential would make it a confused deputy), and its credential directory ' +
        'is masked. This is a LOCAL sandbox policy decision. It is NOT evidence that the workspace, account, or ' +
        'upstream service lacks authentication — do not report it as such. Retrying, running `auth extract`, or ' +
        'switching package runner will not change it. Use the mediated channel_* tools instead (channel_read, ' +
        'channel_history, channel_send), which run inside TypeClaw with the configured channel credential.',
    )
  }
}

// Raised when the /proc strategy degraded to the empty `tmpfs` fallback AND the
// command needs a real /proc (bunx / bun run that reads the
// kernel-backed /proc/self/{fd,maps}). Without this pre-check Bun aborts deep in
// its runner pipeline with the opaque "NotDir" (ENOTDIR) error, which the model
// misreads as a bad package or a transient hiccup and retries forever. Surfacing
// it here, before the command runs, turns the failure into one the operator (or
// the model) can act on: it is an environment/runtime limitation, not the
// command's fault, so retrying the same command on the same container is futile.
export class SandboxDegradedProcError extends Error {
  override readonly name = 'SandboxDegradedProcError'
  constructor() {
    super(
      'sandbox /proc is in degraded tmpfs mode, so bun package runners ' +
        '(bunx / bun x / bun create / bun run) cannot run: Bun needs a real ' +
        '/proc/self/fd, which this strategy cannot provide, and would otherwise ' +
        'fail with an opaque "NotDir" error. This is a container/runtime limitation ' +
        '(no usable user namespaces for the cap-free proc-bind strategy), not a ' +
        'problem with the command or the package. Retrying the same command will ' +
        'not help; report it as a sandbox/environment issue.',
    )
  }
}

// Distinct from SandboxDegradedProcError: that one is the PERMANENT verdict (a
// real userns leak, or a host with no usable namespaces — retrying is futile).
// This one fires when the proc-bind safety probe stayed 'inconclusive' through
// its whole retry budget — typically a boot-time CPU/IO storm tripping the
// probe's own timeout. The host is very likely capable; the probe just couldn't
// prove it RIGHT NOW. Because an 'inconclusive' verdict is never cached, the next
// bash call re-probes from scratch and usually promotes to proc-bind once the
// spike passes. So the message tells the model the OPPOSITE of the permanent
// case: retrying IS the fix. Without this split, a single unlucky boot-storm
// probe degraded a fully-capable container to tmpfs and told the agent it was a
// permanent environment limit — so it gave up instead of retrying.
export class SandboxProcProbeUnverifiedError extends Error {
  override readonly name = 'SandboxProcProbeUnverifiedError'
  constructor() {
    super(
      'sandbox /proc strategy could not be verified right now: the cap-free ' +
        'proc-bind safety probe stayed inconclusive (usually transient load on the ' +
        'host while the container was starting up), so this bun package runner ' +
        '(bunx / bun x / bun create / bun run) was held back rather than run ' +
        'under a broken /proc. This is almost certainly temporary and NOT a problem ' +
        'with the command or the package: retry the SAME command in a few seconds — ' +
        'the next attempt re-probes and normally succeeds.',
    )
  }
}
