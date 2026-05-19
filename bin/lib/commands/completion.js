// `horizon completion <shell>` — emit a shell-specific completion script.
//
// Usage:
//   horizon completion bash    >> ~/.bashrc
//   horizon completion zsh     >> ~/.zshrc
//   horizon completion fish    > ~/.config/fish/completions/horizon.fish
//   horizon completion pwsh    >> $PROFILE
//
// Each shell gets a hand-rolled script (no external deps). Completion
// only covers subcommand names + a few well-known flag values — enough
// to make Tab discovery useful without rebuilding a full grammar.

const { fmt } = require('../tty');

const SUBCOMMANDS = [
  'setup', 'agent', 'chat', 'cost', 'skill', 'mem', 'model', 'persona',
  'connect', 'serve', 'tui', 'doctor', 'profile', 'completion', 'update',
  'version', 'help',
];

const FLAGS = [
  '--json', '--human', '--quiet', '--stream', '--no-stream', '--plain',
  '--provider', '--model', '--persona', '--workspace', '--profile',
  '--max-steps', '--reflect', '--no-reflect', '--auto-approve', '--never-approve',
  '--verbose', '--help', '--version', '--days', '--scope', '--token',
  '--port', '--host', '--enable-tg', '--enable-discord', '--fix', '--yes',
];

const PROVIDERS = [
  'auto', 'claude', 'openai', 'gemini', 'groq', 'deepseek', 'grok',
  'mistral', 'qwen', 'perplexity', 'cohere', 'openrouter',
  'together', 'fireworks', 'deepinfra', 'cerebras', 'sambanova',
  'moonshot', 'zai', 'nebius', 'azure', 'custom',
  'ollama', 'lmstudio', 'localai',
];

const PERSONAS = ['jarvis', 'friday', 'alfred', 'sage', 'pixel'];

function bash() {
  return `# Horizon bash completion — source me from .bashrc
_horizon_complete() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  }
  local subs="${SUBCOMMANDS.join(' ')}"
  local flags="${FLAGS.join(' ')}"
  case "$prev" in
    --provider) COMPREPLY=( $(compgen -W "${PROVIDERS.join(' ')}" -- "$cur") ); return;;
    --persona)  COMPREPLY=( $(compgen -W "${PERSONAS.join(' ')}" -- "$cur") ); return;;
    skill)      COMPREPLY=( $(compgen -W "list show new run enable disable" -- "$cur") ); return;;
    mem)        COMPREPLY=( $(compgen -W "search dump profile forget stats" -- "$cur") ); return;;
    connect)    COMPREPLY=( $(compgen -W "list test telegram discord slack notion linear github" -- "$cur") ); return;;
    profile)    COMPREPLY=( $(compgen -W "list use create show delete rename path" -- "$cur") ); return;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish pwsh" -- "$cur") ); return;;
    cost)       COMPREPLY=( $(compgen -W "dump prune" -- "$cur") ); return;;
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
  elif [[ "$COMP_CWORD" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$subs" -- "$cur") )
  fi
}
complete -F _horizon_complete horizon
complete -F _horizon_complete horizon-tui
complete -F _horizon_complete horizon-serve
`;
}

function zsh() {
  return `# Horizon zsh completion — source me from .zshrc or drop into a #compdef file
_horizon() {
  local -a subs flags providers personas
  subs=(${SUBCOMMANDS.map(s => `'${s}'`).join(' ')})
  flags=(${FLAGS.map(f => `'${f}'`).join(' ')})
  providers=(${PROVIDERS.map(p => `'${p}'`).join(' ')})
  personas=(${PERSONAS.map(p => `'${p}'`).join(' ')})

  case "$words[CURRENT-1]" in
    --provider) compadd -- $providers; return;;
    --persona)  compadd -- $personas; return;;
    skill)      compadd -- list show new run enable disable; return;;
    mem)        compadd -- search dump profile forget stats; return;;
    connect)    compadd -- list test telegram discord slack notion linear github; return;;
    profile)    compadd -- list use create show delete rename path; return;;
    completion) compadd -- bash zsh fish pwsh; return;;
    cost)       compadd -- dump prune; return;;
  esac

  if [[ "$words[CURRENT]" == -* ]]; then
    compadd -- $flags
  elif (( CURRENT == 2 )); then
    compadd -- $subs
  fi
}
compdef _horizon horizon horizon-tui horizon-serve
`;
}

function fish() {
  const subList = SUBCOMMANDS.join(' ');
  let out = `# Horizon fish completion — drop into ~/.config/fish/completions/horizon.fish

complete -c horizon -f
complete -c horizon -n "__fish_use_subcommand" -a "${subList}"
`;
  // Per-flag value completions
  out += `complete -c horizon -l provider -a "${PROVIDERS.join(' ')}"\n`;
  out += `complete -c horizon -l persona -a "${PERSONAS.join(' ')}"\n`;
  for (const f of FLAGS) {
    out += `complete -c horizon -l ${f.replace(/^--/, '')}\n`;
  }
  // Subsub
  out += `complete -c horizon -n "__fish_seen_subcommand_from skill" -a "list show new run enable disable"\n`;
  out += `complete -c horizon -n "__fish_seen_subcommand_from mem" -a "search dump profile forget stats"\n`;
  out += `complete -c horizon -n "__fish_seen_subcommand_from connect" -a "list test telegram discord slack notion linear github"\n`;
  out += `complete -c horizon -n "__fish_seen_subcommand_from profile" -a "list use create show delete rename path"\n`;
  out += `complete -c horizon -n "__fish_seen_subcommand_from completion" -a "bash zsh fish pwsh"\n`;
  out += `complete -c horizon -n "__fish_seen_subcommand_from cost" -a "dump prune"\n`;
  return out;
}

function pwsh() {
  return `# Horizon PowerShell completion — append to $PROFILE
Register-ArgumentCompleter -CommandName 'horizon','horizon-tui','horizon-serve' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $subs = @(${SUBCOMMANDS.map(s => `'${s}'`).join(',')})
  $flags = @(${FLAGS.map(f => `'${f}'`).join(',')})
  $providers = @(${PROVIDERS.map(p => `'${p}'`).join(',')})
  $personas = @(${PERSONAS.map(p => `'${p}'`).join(',')})

  $tokens = $commandAst.CommandElements | ForEach-Object { $_.Extent.Text }
  $last = $tokens[$tokens.Count - 2]

  switch ($last) {
    '--provider' { return $providers | Where-Object { $_ -like "$wordToComplete*" } }
    '--persona'  { return $personas  | Where-Object { $_ -like "$wordToComplete*" } }
    'skill'      { return @('list','show','new','run','enable','disable') | Where-Object { $_ -like "$wordToComplete*" } }
    'mem'        { return @('search','dump','profile','forget','stats') | Where-Object { $_ -like "$wordToComplete*" } }
    'connect'    { return @('list','test','telegram','discord','slack','notion','linear','github') | Where-Object { $_ -like "$wordToComplete*" } }
    'profile'    { return @('list','use','create','show','delete','rename','path') | Where-Object { $_ -like "$wordToComplete*" } }
    'completion' { return @('bash','zsh','fish','pwsh') | Where-Object { $_ -like "$wordToComplete*" } }
    'cost'       { return @('dump','prune') | Where-Object { $_ -like "$wordToComplete*" } }
  }
  if ($wordToComplete -like '-*') {
    return $flags | Where-Object { $_ -like "$wordToComplete*" }
  }
  if ($tokens.Count -le 2) {
    return $subs | Where-Object { $_ -like "$wordToComplete*" }
  }
}
`;
}

async function run({ runtime, args, flags }) {
  const shell = (args[0] || '').toLowerCase();
  const map = { bash, zsh, fish, pwsh, powershell: pwsh };
  if (!map[shell]) {
    process.stderr.write(fmt.err('Usage: horizon completion <bash|zsh|fish|pwsh>') + '\n\n');
    process.stderr.write(fmt.dim('Install hints:') + '\n');
    process.stderr.write('  bash:  ' + fmt.cyan('horizon completion bash >> ~/.bashrc') + '\n');
    process.stderr.write('  zsh:   ' + fmt.cyan('horizon completion zsh  >> ~/.zshrc') + '\n');
    process.stderr.write('  fish:  ' + fmt.cyan('horizon completion fish > ~/.config/fish/completions/horizon.fish') + '\n');
    process.stderr.write('  pwsh:  ' + fmt.cyan('horizon completion pwsh >> $PROFILE') + '\n\n');
    return 2;
  }
  process.stdout.write(map[shell]());
  return 0;
}

module.exports = { run };
