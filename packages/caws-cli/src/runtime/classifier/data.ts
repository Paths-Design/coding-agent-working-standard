/** Command policy data carried from the reviewed stock classifier. Order is significant. */
export const SAFE_DELETE_PREFIXES = [
  'target/',
  'tmp/',
  '.pytest_cache/',
  'node_modules/',
  '__pycache__/',
] as const;
export const SYSTEM_TMP_PREFIXES = [
  '/tmp/',
  '/private/tmp/',
  '/private/var/folders/',
  '/var/folders/',
] as const;
export const DENY_PIPELINE_PATTERNS = [
  ['\\b(curl|wget)\\b[^|]*\\|\\s*(ba)?sh\\b', 'pipe-to-shell execution'],
  ['[^|]\\|\\s*(ba)?sh\\b', 'generic pipe-to-shell execution — pipe target is a shell interpreter'],
  [':\\(\\)\\s*\\{.*:\\|:.*\\}\\s*;\\s*:', 'fork bomb'],
  ['\\bwhile\\s+true\\b.*\\bfork\\b', 'fork loop'],
] as const;
export const GENERIC_PIPE_TO_SHELL_DESC =
  'generic pipe-to-shell execution — pipe target is a shell interpreter' as const;
export const DENY_SEGMENT_PATTERNS = [
  ['\\bdd\\b.*\\bif=/dev/(zero|random)\\b', 'dd with destructive input'],
  ['\\bmkfs\\.', 'filesystem format'],
  ['\\bfdisk\\b', 'disk partitioning'],
  ['>\\s*/dev/sd', 'raw device write'],
  ['\\bchmod\\b.*\\+s\\b', 'setuid/setgid bit'],
  ['\\bchmod\\b.*\\b777\\b', 'chmod 777'],
  ['\\b(shutdown|reboot)\\b', 'system shutdown/reboot'],
  ['\\binit\\s+[06]\\b', 'system runlevel change'],
  ['\\bgit\\s+reset\\s+--hard\\b', 'git reset --hard'],
  ['\\bgit\\s+push\\s+(-f\\b|--force\\b|--force-with-lease\\b)', 'git force push'],
  ['\\bgit\\s+clean\\s+-[a-zA-Z]*f', 'git clean with force'],
  ['\\bgit\\s+checkout\\s+\\.\\s*$', 'git checkout . (discard all changes)'],
  ['\\bgit\\s+restore\\s+\\.\\s*$', 'git restore . (discard all changes)'],
  ['^sudo\\s+(?!npm|yarn|pnpm|brew|apt-get|apt|dnf|yum)', 'sudo command'],
  [
    '\\bcat\\b.*(\\.env(?!\\.(example|sample|template|dist|defaults)\\b)|\\.ssh/(?![^\\s]*\\.pub\\b)|\\.aws/)',
    'credential file read',
  ],
  ['\\bcat\\b.*/etc/(passwd|shadow)\\b', 'system credential read'],
  ['\\bcat\\b.*(id_rsa(?!\\.pub\\b)|credentials)\\b', 'credential file read'],
  [
    '(^|[|;&(])\\s*(head|tail|less|more|base64|xxd|od|strings|cp)\\b.*(\\.env(?!\\.(example|sample|template|dist|defaults)\\b)|\\.ssh/(?![^\\s]*\\.pub\\b)|\\.aws/|id_rsa(?!\\.pub\\b)|credentials\\b)',
    'credential file read',
  ],
  [
    '(^|[|;&(])\\s*(head|tail|less|more|base64|xxd|od|strings|cp)\\b.*/etc/(passwd|shadow)\\b',
    'system credential read',
  ],
  [
    '\\b(rm|mv)\\b[^\\n]*\\.caws/specs/[^\\s\'\\"]*\\.ya?ml\\b',
    'naked rm/mv on .caws/specs/*.yaml — use `caws specs close|archive <id>`',
  ],
  [
    '\\b(rm|mv)\\b[^\\n]*\\.caws/policy\\.ya?ml\\b',
    'naked rm/mv on .caws/policy.yaml — policy is governed; change it with Edit under an active spec whose scope admits it',
  ],
  [
    '\\b(rm|mv)\\b[^\\n]*\\.caws/waivers/[^\\s\'\\"]*\\.ya?ml\\b',
    'naked rm/mv on .caws/waivers/*.yaml — use `caws waiver revoke <id>`',
  ],
] as const;
export const DENY_RAW_SEGMENT_PATTERNS = [
  [
    '(?i)--(approved-by|revoked-by|approver|granted-by|authorized-by)[=\\s]+[\'\\"]?[^\\s\'\\"]*?@?(?:{OWNER})\\b',
    "agent signing the machine owner's identity into an authorization flag — an approver field means a HUMAN owned the bypass; pass your agent session id (claude-agent:<session-id>), or ask the owner to grant it",
  ],
  [
    '(?i)\\b(approved_by|revoked_by|approver|authorized_by|granted_by)\\s*:\\s*[\'\\"]?[^\\s\'\\"]*?@?(?:{OWNER})\\b',
    "agent writing the machine owner's identity into an authorization field — an approver field means a HUMAN owned the bypass; write your agent session id (claude-agent:<session-id>), or ask the owner to grant it",
  ],
] as const;
export const CONFIRM_SEGMENT_PATTERNS = [
  ['\\bgit\\s+rebase\\b', 'git rebase (rewrites branch history)'],
  ['\\bgit\\s+cherry-pick\\b', 'git cherry-pick (replays commits across branches)'],
  ['\\bhistory\\s+-c\\b', 'history clear'],
  ['\\bpython3?\\s+-m\\s+venv\\b', 'virtual environment creation'],
  ['\\bvirtualenv\\s', 'virtual environment creation'],
  ['\\bconda\\s+create\\b', 'conda environment creation'],
] as const;
export const GIT_GLOBAL_OPTIONS_WITH_VALUE = [
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--work-tree',
  '-C',
  '-c',
] as const;
export const GIT_GLOBAL_OPTIONS_NO_VALUE = [
  '--bare',
  '--glob-pathspecs',
  '--icase-pathspecs',
  '--literal-pathspecs',
  '--no-pager',
  '--no-replace-objects',
  '--noglob-pathspecs',
  '--paginate',
] as const;
export const COMMAND_WRAPPERS = ['builtin', 'command', 'nohup'] as const;
export const SHELL_C_WRAPPERS = ['bash', 'dash', 'sh', 'zsh'] as const;
export const ALLOWED_SIMPLE_COMMANDS = [
  'cat',
  'df',
  'du',
  'file',
  'grep',
  'head',
  'less',
  'ls',
  'more',
  'rg',
  'stat',
  'tail',
  'tree',
  'wc',
] as const;
export const ALLOWED_GIT_SUBCOMMANDS = [
  'add',
  'blame',
  'branch',
  'cat-file',
  'check-ignore',
  'config',
  'diff',
  'log',
  'ls-files',
  'merge-tree',
  'remote',
  'rev-list',
  'rev-parse',
  'show',
  'status',
  'tag',
] as const;
export const ALLOWED_GH_ACTIONS = [
  'issue list',
  'issue view',
  'pr checks',
  'pr diff',
  'pr list',
  'pr status',
  'pr view',
  'release list',
  'release view',
  'repo view',
  'run list',
  'run view',
] as const;
export const GH_MUTATING_ACTIONS = [
  'issue close',
  'issue create',
  'issue edit',
  'pr close',
  'pr comment',
  'pr edit',
  'pr merge',
  'pr ready',
  'pr reopen',
  'pr review',
  'release create',
  'release delete',
  'release edit',
  'run cancel',
  'run rerun',
  'workflow disable',
  'workflow enable',
  'workflow run',
] as const;
export const ALLOWED_NPM_SUBCOMMANDS = [
  'config',
  'explain',
  'ls',
  'outdated',
  'view',
  'whoami',
] as const;
export const GOVERNED_FAMILIES = ['gh', 'git', 'npm'] as const;
export const MAX_RECURSION_DEPTH = 8 as const;
export const FACET_KINDS = [
  'DESTROY',
  'EXEC',
  'MUTATE',
  'NONE',
  'PRIV_ESC',
  'READ',
  'SECRETS_READ',
] as const;
export const FACET_DOMAINS = [
  'cloud',
  'container',
  'filesystem',
  'http',
  'iac',
  'local',
  'process',
  'remote_orchestrator',
  'unknown',
] as const;
export const FACET_SCOPES = ['broad', 'narrow', 'prod', 'unknown'] as const;
export const FACET_REVERSIBILITY = ['irreversible', 'partial', 'reversible', 'unknown'] as const;
export const FACET_OPACITY = ['literal', 'none', 'opaque'] as const;
export const FACET_BLAST = ['cluster', 'host', 'multi', 'single', 'unknown'] as const;
export const MUTATION_AMPLIFIER_FLAGS = [
  '--all',
  '--auto-approve',
  '--delete',
  '--destroy',
  '--force',
  '--prune',
  '--recursive',
  '--volumes',
  '--yes',
  '-R',
  '-f',
  '-r',
  '-y',
] as const;
export const BROAD_SCOPE_INDICATORS = ['--all', '--all-namespaces', '-A'] as const;
export const PROD_SCOPE_INDICATORS = ['live', 'prod', 'production', 'staging'] as const;
export const OPAQUE_EXEC_EXECUTABLES = [
  'bash',
  'dash',
  'eval',
  'exec',
  'node',
  'perl',
  'python',
  'python3',
  'ruby',
  'sh',
  'xargs',
  'zsh',
] as const;
export const DEFAULT_ADAPTERS = {
  kubectl: [
    [
      ['delete'],
      {
        kind: 'DESTROY',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'single',
        trace: 'K8S_DELETE',
      },
    ],
    [
      ['delete', 'namespace'],
      {
        kind: 'DESTROY',
        domain: 'remote_orchestrator',
        reversibility: 'irreversible',
        blast: 'cluster',
        trace: 'K8S_DELETE_BROAD',
      },
    ],
    [
      ['delete', 'ns'],
      {
        kind: 'DESTROY',
        domain: 'remote_orchestrator',
        reversibility: 'irreversible',
        blast: 'cluster',
        trace: 'K8S_DELETE_BROAD',
      },
    ],
    [
      ['delete', 'crd'],
      {
        kind: 'DESTROY',
        domain: 'remote_orchestrator',
        reversibility: 'irreversible',
        blast: 'cluster',
        trace: 'K8S_DELETE_BROAD',
      },
    ],
    [
      ['delete', 'pv'],
      {
        kind: 'DESTROY',
        domain: 'remote_orchestrator',
        reversibility: 'irreversible',
        blast: 'cluster',
        trace: 'K8S_DELETE_BROAD',
      },
    ],
    [
      ['delete', 'pvc'],
      {
        kind: 'DESTROY',
        domain: 'remote_orchestrator',
        reversibility: 'irreversible',
        blast: 'cluster',
        trace: 'K8S_DELETE_BROAD',
      },
    ],
    [
      ['delete', 'secret'],
      {
        kind: 'DESTROY',
        domain: 'remote_orchestrator',
        reversibility: 'irreversible',
        blast: 'cluster',
        trace: 'K8S_DELETE_BROAD',
      },
    ],
    [
      ['apply'],
      {
        kind: 'MUTATE',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'single',
        trace: 'K8S_MUTATE',
      },
    ],
    [
      ['scale'],
      {
        kind: 'MUTATE',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'single',
        trace: 'K8S_MUTATE',
      },
    ],
    [
      ['patch'],
      {
        kind: 'MUTATE',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'single',
        trace: 'K8S_MUTATE',
      },
    ],
    [
      ['exec'],
      {
        kind: 'MUTATE',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'single',
        trace: 'K8S_EXEC',
      },
    ],
  ],
  helm: [
    [
      ['uninstall'],
      {
        kind: 'DESTROY',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'K8S_DELETE',
      },
    ],
    [
      ['delete'],
      {
        kind: 'DESTROY',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'K8S_DELETE',
      },
    ],
    [
      ['install'],
      {
        kind: 'MUTATE',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'K8S_MUTATE',
      },
    ],
    [
      ['upgrade'],
      {
        kind: 'MUTATE',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'K8S_MUTATE',
      },
    ],
    [
      ['rollback'],
      {
        kind: 'MUTATE',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'K8S_MUTATE',
      },
    ],
  ],
  docker: [
    [
      ['system', 'prune'],
      {
        kind: 'DESTROY',
        domain: 'container',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'CONTAINER_PRUNE',
      },
    ],
    [
      ['volume', 'prune'],
      {
        kind: 'DESTROY',
        domain: 'container',
        reversibility: 'irreversible',
        blast: 'multi',
        trace: 'CONTAINER_PRUNE',
      },
    ],
    [
      ['volume', 'rm'],
      {
        kind: 'DESTROY',
        domain: 'container',
        reversibility: 'irreversible',
        blast: 'single',
        trace: 'CONTAINER_VOLUME_RM',
      },
    ],
    [
      ['image', 'prune'],
      {
        kind: 'DESTROY',
        domain: 'container',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'CONTAINER_PRUNE',
      },
    ],
    [
      ['run'],
      {
        kind: 'MUTATE',
        domain: 'container',
        reversibility: 'reversible',
        blast: 'single',
        trace: 'CONTAINER_RUN',
      },
    ],
    [
      ['rm'],
      {
        kind: 'DESTROY',
        domain: 'container',
        reversibility: 'partial',
        blast: 'single',
        trace: 'CONTAINER_RM',
      },
    ],
    [
      ['rmi'],
      {
        kind: 'DESTROY',
        domain: 'container',
        reversibility: 'partial',
        blast: 'single',
        trace: 'CONTAINER_RM',
      },
    ],
    [
      ['compose', 'up'],
      {
        kind: 'MUTATE',
        domain: 'container',
        reversibility: 'reversible',
        blast: 'multi',
        trace: 'CONTAINER_RUN',
      },
    ],
    [
      ['compose', 'down'],
      {
        kind: 'DESTROY',
        domain: 'container',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'CONTAINER_RM',
      },
    ],
  ],
  'docker-compose': [
    [
      ['up'],
      {
        kind: 'MUTATE',
        domain: 'container',
        reversibility: 'reversible',
        blast: 'multi',
        trace: 'CONTAINER_RUN',
      },
    ],
    [
      ['down'],
      {
        kind: 'DESTROY',
        domain: 'container',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'CONTAINER_RM',
      },
    ],
  ],
  podman: [
    [
      ['run'],
      {
        kind: 'MUTATE',
        domain: 'container',
        reversibility: 'reversible',
        blast: 'single',
        trace: 'CONTAINER_RUN',
      },
    ],
    [
      ['rm'],
      {
        kind: 'DESTROY',
        domain: 'container',
        reversibility: 'partial',
        blast: 'single',
        trace: 'CONTAINER_RM',
      },
    ],
  ],
  kind: [
    [
      ['create'],
      {
        kind: 'MUTATE',
        domain: 'remote_orchestrator',
        reversibility: 'reversible',
        blast: 'single',
        trace: 'K8S_MUTATE',
      },
    ],
    [
      ['delete'],
      {
        kind: 'DESTROY',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'single',
        trace: 'K8S_DELETE',
      },
    ],
  ],
  minikube: [
    [
      ['start'],
      {
        kind: 'MUTATE',
        domain: 'container',
        reversibility: 'reversible',
        blast: 'single',
        trace: 'CONTAINER_RUN',
      },
    ],
    [
      ['delete'],
      {
        kind: 'DESTROY',
        domain: 'container',
        reversibility: 'partial',
        blast: 'single',
        trace: 'CONTAINER_RM',
      },
    ],
  ],
  'ansible-playbook': [
    [
      [],
      {
        kind: 'MUTATE',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'ANSIBLE_APPLY',
      },
    ],
  ],
  doas: [
    [
      [],
      {
        kind: 'PRIV_ESC',
        domain: 'local',
        reversibility: 'unknown',
        blast: 'host',
        trace: 'PRIV_ESC',
      },
    ],
  ],
  modprobe: [
    [
      [],
      {
        kind: 'MUTATE',
        domain: 'local',
        reversibility: 'partial',
        blast: 'host',
        trace: 'KERNEL_MODULE',
      },
    ],
  ],
  insmod: [
    [
      [],
      {
        kind: 'MUTATE',
        domain: 'local',
        reversibility: 'partial',
        blast: 'host',
        trace: 'KERNEL_MODULE',
      },
    ],
  ],
  rmmod: [
    [
      [],
      {
        kind: 'MUTATE',
        domain: 'local',
        reversibility: 'partial',
        blast: 'host',
        trace: 'KERNEL_MODULE',
      },
    ],
  ],
  chroot: [
    [
      [],
      {
        kind: 'MUTATE',
        domain: 'process',
        reversibility: 'partial',
        blast: 'host',
        trace: 'NS_ENTER',
      },
    ],
  ],
  unshare: [
    [
      [],
      {
        kind: 'MUTATE',
        domain: 'process',
        reversibility: 'partial',
        blast: 'host',
        trace: 'NS_ENTER',
      },
    ],
  ],
  nsenter: [
    [
      [],
      {
        kind: 'MUTATE',
        domain: 'process',
        reversibility: 'partial',
        blast: 'host',
        trace: 'NS_ENTER',
      },
    ],
  ],
  'ssh-copy-id': [
    [
      [],
      {
        kind: 'MUTATE',
        domain: 'remote_orchestrator',
        reversibility: 'partial',
        blast: 'single',
        trace: 'REMOTE_CRED_WRITE',
      },
    ],
  ],
  dd: [
    [
      [],
      {
        kind: 'MUTATE',
        domain: 'filesystem',
        reversibility: 'partial',
        blast: 'single',
        trace: 'FS_DD',
      },
    ],
  ],
  terraform: [
    [
      ['destroy'],
      {
        kind: 'DESTROY',
        domain: 'iac',
        reversibility: 'irreversible',
        blast: 'multi',
        trace: 'IAC_DESTROY',
      },
    ],
    [
      ['apply'],
      {
        kind: 'MUTATE',
        domain: 'iac',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'IAC_APPLY',
      },
    ],
  ],
  pulumi: [
    [
      ['destroy'],
      {
        kind: 'DESTROY',
        domain: 'iac',
        reversibility: 'irreversible',
        blast: 'multi',
        trace: 'IAC_DESTROY',
      },
    ],
    [
      ['up'],
      {
        kind: 'MUTATE',
        domain: 'iac',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'IAC_APPLY',
      },
    ],
  ],
  shred: [
    [
      [],
      {
        kind: 'DESTROY',
        domain: 'filesystem',
        reversibility: 'irreversible',
        blast: 'single',
        trace: 'FS_SHRED',
      },
    ],
  ],
  truncate: [
    [
      [],
      {
        kind: 'DESTROY',
        domain: 'filesystem',
        reversibility: 'partial',
        blast: 'single',
        trace: 'FS_ZERO_FILE',
      },
    ],
  ],
  chown: [
    [
      [],
      {
        kind: 'MUTATE',
        domain: 'filesystem',
        reversibility: 'partial',
        blast: 'single',
        trace: 'FS_CHOWN_R',
      },
    ],
  ],
  kill: [
    [
      [],
      {
        kind: 'DESTROY',
        domain: 'process',
        reversibility: 'partial',
        blast: 'single',
        trace: 'PROC_KILL',
      },
    ],
  ],
  pkill: [
    [
      [],
      {
        kind: 'DESTROY',
        domain: 'process',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'PROC_KILL_BROAD',
      },
    ],
  ],
  killall: [
    [
      [],
      {
        kind: 'DESTROY',
        domain: 'process',
        reversibility: 'partial',
        blast: 'multi',
        trace: 'PROC_KILL_BROAD',
      },
    ],
  ],
} as const;
export const CLOUD_CLIS = ['aws', 'az', 'doctl', 'gcloud'] as const;
export const DESTROY_VERBS = ['delete', 'destroy', 'rb', 'remove', 'rm', 'terminate'] as const;
export const MUTATE_VERBS = ['apply', 'create', 'modify', 'patch', 'put', 'set', 'update'] as const;
export const _GIT_ENV_REDIRECT_PREFIXES = [
  'GIT_DIR=',
  'GIT_WORK_TREE=',
  'GIT_INDEX_FILE=',
] as const;
export const _COMMIT_SHORT_OPTS_WITH_VALUE = 'mFCctS' as const;
