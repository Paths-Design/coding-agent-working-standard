'use strict';

// Test workers must not borrow the invoking human/agent's identity, machine
// registration, project root or kill authority. Tests of those inputs set them
// explicitly after setup. Artifact destinations and test-selection flags remain.
for (const key of [
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'CAWS_SESSION_ID',
  'HOOK_SESSION_ID',
  'CURSOR_TRACE_ID',
  'QWEN_CODE_SESSION_ID',
  'DSH_SESSION_ID',
  'CAWS_AGENT_SURFACE',
  'CAWS_PLATFORM_FLAG',
  'CAWS_PROJECT_DIR',
  'CAWS_HOME',
  'CAWS_AGENT_PROCESS_NAMES',
  'CAWS_TRAP_KILL',
])
  delete process.env[key];
