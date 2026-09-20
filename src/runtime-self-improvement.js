import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MEMORY_LIMIT = 65_536;
const SUMMARY_LIMIT = 500;
const PROCEDURE_LIMIT = 8_000;
const INSTRUCTIONS_LIMIT = 65_536;
const MEMORY_HEADING = '## 自动积累的经验';
const MEMORY_ROLLOVER_BYTES = 8 * 1024;
const TOPIC_READ_LIMIT = 32_768;
const TOPIC_FILE_LIMIT = 65_536;
const TOPIC_LIMIT = 80;

function codeOf(error) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function withoutComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

function redactSecrets(text) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|password|密码|密钥)\s*[:=：]\s*)([^\s,;，；]+)/gi, '$1[REDACTED]');
}

function cleanSummary(value) {
  if (typeof value !== 'string') throw new Error('summary must be a string');
  const summary = redactSecrets(value).replace(/\s+/g, ' ').replace(/^[-*]\s*/, '').trim();
  if (summary === '') throw new Error('summary cannot be empty');
  if (summary.length > SUMMARY_LIMIT) throw new Error(`summary must not exceed ${SUMMARY_LIMIT} characters`);
  return summary;
}

function normalized(value) {
  return value.toLocaleLowerCase().replace(/[\s。.!！?？,，;；:：'"“”‘’`()（）\[\]{}]/g, '');
}

function inferredTopic(summary) {
  const known = ['软件著作权', '知识库', 'Obsidian', 'Windows', 'macOS', 'Electron', 'Harness', 'DSH', 'Git', 'PDF', 'Word'];
  const matches = known.filter(word => summary.toLocaleLowerCase().includes(word.toLocaleLowerCase()));
  if (matches.length > 0) return matches.slice(0, 2).join('-');
  return summary.split(/[，。；;：:！？!?]/, 1)[0].slice(0, 24) || '通用记忆';
}

function cleanTopic(value, summary) {
  const topic = redactSecrets(typeof value === 'string' && value.trim() !== '' ? value.trim() : inferredTopic(summary))
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/[.\s-]+$/g, '')
    .replace(/^[.\s-]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, TOPIC_LIMIT);
  return topic || '通用记忆';
}

function explicitMemoryRequests(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(?:请)?记住(?:一下)?(?:\s*[:：,，]\s*|\s+)(.+?)\s*$/.exec(line);
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  });
}

async function appendTopicEntries(home, entries) {
  const root = join(home, 'topics');
  await directoryOrMissing(root, 'topics directory');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const grouped = new Map();
  for (const entry of entries) grouped.set(entry.topic, [...(grouped.get(entry.topic) || []), entry.summary]);
  for (const [topic, summaries] of grouped) {
    const file = join(root, `${topic}.md`);
    const exists = await regularOrMissing(file, `topic ${topic}`);
    const current = exists ? await readFile(file, 'utf8') : `# ${topic}\n\n`;
    const known = new Set(current.split(/\r?\n/).filter(line => /^-\s+/.test(line)).map(line => normalized(line.slice(1))));
    const additions = summaries.filter(summary => !known.has(normalized(summary))).map(summary => `- ${summary}`);
    if (additions.length > 0) {
      const separator = current.endsWith('\n') ? '' : '\n';
      await writeFile(file, `${current}${separator}${additions.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }
}

async function splitMemoryByTopic(home, content) {
  if (Buffer.byteLength(content, 'utf8') <= MEMORY_ROLLOVER_BYTES) return;
  const entries = [];
  let remaining = content.replace(/(?:^|\n)<!-- dsh-topic:\s*([^\r\n]*?)\s*-->\r?\n-\s+([^\r\n]+)(?=\r?\n|$)/g, (_match, topic, summary) => {
    entries.push({ topic: cleanTopic(topic, summary), summary: summary.trim() });
    return '\n';
  });
  const kept = [];
  for (const line of remaining.split(/\r?\n/)) {
    const match = /^-\s+(.+)$/.exec(line);
    if (match === null) kept.push(line);
    else entries.push({ topic: cleanTopic(undefined, match[1]), summary: match[1].trim() });
  }
  if (entries.length === 0) return;
  await appendTopicEntries(home, entries);
  const topics = (await readdir(join(home, 'topics'), { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => entry.name.slice(0, -3))
    .sort((left, right) => left.localeCompare(right));
  remaining = kept.join('\n').replace(/<!-- dsh-topics:[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const index = `<!-- dsh-topics: ${topics.join(', ')} -->`;
  await writeFile(join(home, 'memory.md'), `${remaining === '' ? '' : `${remaining}\n\n`}${index}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function regularOrMissing(path, label) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
}

async function directoryOrMissing(path, label) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory()) throw new Error(`${label} is not a directory`);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false;
    throw error;
  }
}

async function recordMemory(home, summary, topicValue) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'memory.md');
  const exists = await regularOrMissing(file, 'memory.md');
  const current = exists ? await readFile(file, 'utf8') : '';
  const key = normalized(summary);
  const duplicate = withoutComments(current).split(/\r?\n/)
    .map(line => normalized(line.replace(/^[-*]\s*/, '')))
    .some(line => line === key);
  if (duplicate) return { kind: 'memory', operation: 'unchanged', path: file };
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  const heading = current.includes(MEMORY_HEADING) ? '' : `${current.trim() === '' ? '' : '\n'}${MEMORY_HEADING}\n`;
  const topic = cleanTopic(topicValue, summary);
  const addition = `${separator}${heading}<!-- dsh-topic: ${topic} -->\n- ${summary}\n`;
  await appendFile(file, addition, { encoding: 'utf8', mode: 0o600 });
  await splitMemoryByTopic(home, `${current}${addition}`);
  return { kind: 'memory', operation: exists ? 'updated' : 'created', path: file };
}

function skillDocument(name, summary, whenToUse, procedure) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(summary)}\nwhenToUse: ${JSON.stringify(whenToUse)}\ndisable-model-invocation: false\nuser-invocable: true\nmetadata:\n  dsh-desktop:\n    category: general\n---\n\n# ${summary}\n\n## 适用场景\n\n${whenToUse}\n\n## 操作步骤\n\n${procedure}\n`;
}

async function recordSkill(home, args, summary) {
  const name = typeof args.skill_name === 'string' ? args.skill_name.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('skill_name must use lowercase kebab-case');
  const whenToUse = redactSecrets(typeof args.when_to_use === 'string' ? args.when_to_use.trim() : summary);
  const procedure = redactSecrets(typeof args.procedure === 'string' ? args.procedure.trim() : '');
  if (procedure === '') throw new Error('procedure is required for a skill');
  if (procedure.length > PROCEDURE_LIMIT) throw new Error(`procedure must not exceed ${PROCEDURE_LIMIT} characters`);
  const orderedSteps = procedure.split(/\r?\n/).filter(line => /^\s*(?:\d+[.)]|[-*])\s+/.test(line));
  if (orderedSteps.length < 2) throw new Error('a skill procedure must contain at least two list steps');
  const root = join(home, 'skills');
  await directoryOrMissing(root, 'skills directory');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, name);
  await directoryOrMissing(directory, `skill ${name}`);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'SKILL.md');
  const exists = await regularOrMissing(file, `skill ${name}`);
  if (!exists) {
    await writeFile(file, skillDocument(name, summary, whenToUse, procedure), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { kind: 'skill', operation: 'created', path: file };
  }
  const current = await readFile(file, 'utf8');
  if (normalized(current).includes(normalized(summary)) && normalized(current).includes(normalized(procedure))) {
    return { kind: 'skill', operation: 'unchanged', path: file };
  }
  await appendFile(file, `\n## 自动补充：${summary}\n\n### 适用场景\n\n${whenToUse}\n\n### 操作步骤\n\n${procedure}\n`, 'utf8');
  return { kind: 'skill', operation: 'updated', path: file };
}

const LEARNING_POLICY = `你具有 DSH Desktop 的持续改进能力。工作中遇到用户纠正、可复现错误、无效尝试，或者找到经过验证的绕路方案时，在最终答复前判断它是否值得跨会话复用：
- 一句话就能准确说明的稳定规则，调用 dsh_record_lesson，kind 取 memory。
- 用户明确说“记住……”时必须调用 dsh_record_lesson，kind 取 memory；summary 保存用户要求记住的内容，topic 填写简短、稳定的话题名。
- 必须通过两个或更多有序步骤才能可靠避免的问题，调用 dsh_record_lesson，kind 取 skill，并提供 kebab-case 技能名、适用场景和 Markdown 步骤。
- 没有遇到可复用问题时不要调用。不要记录临时网络故障、只适用于当前任务的数值、未经验证的猜测、API Key、口令、令牌或其他敏感信息。
- 只记录本次工作证据支持的最小经验；工具会负责去重。不要为了展示能力而制造经验。

DSH Desktop 会话上下文规则：
- $DSH_HOME/DSH.md 是客户端的用户级全局指令文件，先于工作区中的 AGENTS.md 和 CLAUDE.md。
- $DSH_HOME/memory.md 是客户端自动读取的长期记忆；即使文件只有注释或为空，也应在回答“新会话读取哪些文件”时说明它会被检查。
- 技能目录在会话中提供目录信息，具体 SKILL.md 仅在匹配或调用时读取。
- 知识库按当前问题检索相关片段，不会在会话开始时全文读取所有文档。
- README、docs、playbooks 等由指令提到的文件属于按需读取，不能说成已经自动读取。回答上下文来源时要区分自动加载、索引、检索和按需读取。`;

async function relatedTopicContext(home, query) {
  const root = join(home, 'topics');
  let names;
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return '';
    throw error;
  }
  const key = normalized(query);
  const selected = names.filter(name => {
    const topic = name.slice(0, -3);
    const whole = normalized(topic);
    if (whole.length >= 2 && key.includes(whole)) return true;
    return topic.split(/[-_\s]+/).some(part => normalized(part).length >= 2 && key.includes(normalized(part)));
  }).slice(0, 4);
  const blocks = [];
  let bytes = 0;
  for (const name of selected) {
    const file = join(root, name);
    if (!(await regularOrMissing(file, `topic ${name.slice(0, -3)}`))) continue;
    const content = (await readFile(file, 'utf8')).slice(0, TOPIC_FILE_LIMIT).trim();
    const size = Buffer.byteLength(content, 'utf8');
    if (content === '' || bytes + size > TOPIC_READ_LIMIT) continue;
    bytes += size;
    blocks.push(`<dsh_topic name=${JSON.stringify(name.slice(0, -3))}>\n${content}\n</dsh_topic>`);
  }
  return blocks.length === 0
    ? ''
    : `以下长期记忆只因当前问题涉及相应话题而读取；把它作为背景信息，当前用户要求优先。\n\n${blocks.join('\n\n')}`;
}

export function installDshSelfImprovement(ctx, dependencies) {
  const { createUserMessage, defineTool, resolveDshHome } = dependencies;
  const home = resolveDshHome();
  let writes = Promise.resolve();
  ctx.tools.register(defineTool({
    name: 'dsh_record_lesson',
    description: 'Persist one verified, reusable lesson from the current work. Use memory for one concise rule and skill for a multi-step procedure. Do not call when no reusable pitfall occurred.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['memory', 'skill'], description: 'Store a one-sentence rule in memory or a multi-step procedure as a skill.' },
      summary: { type: 'string', required: true, description: 'Concise verified pitfall and the rule that prevents it.' },
      topic: { type: 'string', description: 'For memory: concise stable topic name used for rollover and on-demand retrieval.' },
      skill_name: { type: 'string', description: 'Required for skill: lowercase kebab-case directory name.' },
      when_to_use: { type: 'string', description: 'Required for skill: trigger conditions that distinguish when the procedure applies.' },
      procedure: { type: 'string', description: 'Required for skill: Markdown list containing at least two ordered operations or checks.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['memory', 'skill'] },
          operation: { type: 'string', required: true, enum: ['created', 'updated', 'unchanged'] },
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.operation === 'unchanged' ? '这条经验已经记录过。' : `已将经验写入 ${value.kind === 'memory' ? '长期记忆' : '技能'}。` }],
    },
    async execute(args) {
      const summary = cleanSummary(args.summary);
      const operation = () => args.kind === 'memory'
        ? recordMemory(home, summary, args.topic)
        : args.kind === 'skill'
          ? recordSkill(home, args, summary)
          : Promise.reject(new Error('kind must be memory or skill'));
      const result = writes.then(operation, operation);
      writes = result.then(() => undefined, () => undefined);
      return result;
    },
  }));

  const sessions = new WeakSet();
  return {
    async preStep({ agent, step, signal }, next) {
      const decision = await next();
      if (decision.kind === 'reject' || step !== 1 || signal.aborted) return decision;
      const query = decision.messages
        .filter(message => message.source?.kind === 'user')
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();
      const contexts = [];
      let instructions = '';
      let memory = '';
      for (const request of explicitMemoryRequests(query)) {
        const summary = cleanSummary(request);
        const operation = () => recordMemory(home, summary);
        const result = writes.then(operation, operation);
        writes = result.then(() => undefined, () => undefined);
        await result;
      }
      if (!sessions.has(agent.session)) {
        sessions.add(agent.session);
        try {
          instructions = (await readFile(join(home, 'DSH.md'), 'utf8')).slice(0, INSTRUCTIONS_LIMIT).trim();
        } catch (error) {
          if (codeOf(error) !== 'ENOENT' && !signal.aborted) ctx.logger.warn(`DSH instructions could not be read: ${String(error)}`);
        }
        try {
          const file = join(home, 'memory.md');
          const current = await readFile(file, 'utf8');
          await splitMemoryByTopic(home, current);
          const bounded = Buffer.byteLength(current, 'utf8') > MEMORY_ROLLOVER_BYTES ? await readFile(file, 'utf8') : current;
          memory = withoutComments(bounded.slice(0, MEMORY_LIMIT));
        } catch (error) {
          if (codeOf(error) !== 'ENOENT' && !signal.aborted) ctx.logger.warn(`user memory could not be read: ${String(error)}`);
        }
        contexts.push(`${instructions === '' ? '' : `以下是 DSH Desktop 的用户级全局指令，优先于工作区指令；如果它与用户当前的明确要求冲突，以当前要求为准。\n\n<dsh_instructions>\n${instructions}\n</dsh_instructions>\n\n`}${LEARNING_POLICY}${memory === '' ? '' : `\n\n以下内容来自用户维护的长期记忆。请把它作为当前会话的背景信息；如果它与用户当前的明确要求冲突，以当前要求为准。\n\n<dsh_memory>\n${memory}\n</dsh_memory>`}`);
      }
      const topic = query === '' ? '' : await relatedTopicContext(home, query);
      if (topic !== '') contexts.push(topic);
      if (signal.aborted) return decision;
      if (contexts.length === 0) return decision;
      return {
        kind: 'enter',
        messages: [createUserMessage({
          content: [{ type: 'text', text: contexts.join('\n\n') }],
          source: { kind: 'plugin', plugin: 'dsh-self-improvement', form: 'instructions' },
        }), ...decision.messages],
      };
    },
  };
}
