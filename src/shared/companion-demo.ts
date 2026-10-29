import type { ChatContext } from '../server/companion-prompt';

// Local fixtures only: conversational presentation is not real model inference.
export function companionDemoText(c: ChatContext): string {
  const message = c.message.trim();
  if (/你(?:到底)?是(?:谁|什么人|哪位)|你叫(?:什么|啥)|你是真人吗|你是(?:AI|人工智能|机器人)吗|你是不是(?:AI|人工智能|机器人|真人)/i.test(message))
    return `我是${c.role.name}，和你聊天的AI角色，不是真人。`;
  if (/^[?？!！\s]+$/.test(message)) return '我刚才没接住你的意思。你想问哪一句？';
  if (/^(?:是你|真的是你|你吗)[?？!！。呀啊\s]*$/.test(message)) return '嗯，我在。你是在确认刚才那句话吗？';
  if (/^(?:不|不想|不想聊|不想说|不要|算了|没什么|没啥)[了呀啊吧。！!\s]*$/.test(message))
    return c.role.personality === '活泼有趣' ? '好，那就先放一边。换个话题也行，你来挑。' : '好，那就先不聊这个。你想说的时候，我听着。';
  if (/^(?:你好|嗨|哈喽|哈啰|在吗|在不在|hello|hi)[呀啊哦~～!！?？。\s]*$/i.test(message)) {
    if (c.role.relationship === 'partner') return '嗯，在呢。今天过得怎么样？';
    if (c.role.personality === '活泼有趣') return '嗨，来啦！今天有什么新鲜事？';
    if (c.role.personality === '理性坦诚') return '嗯，在。今天怎么样？';
    return '嗨，我在呢。今天过得还好吗？';
  }
  const memory = c.memories.find(m => m.status === 'confirmed');
  if (/记得|记住|喜好/.test(message) && memory) return `你确认的${memory.subject === 'user' ? '个人事实' : memory.subject === 'role' ? 'AI角色设定' : memory.subject === 'reference' ? '历史参考人物资料' : '主体未明确资料'}里有：“${memory.text}”需要修改的话，可以到事实记忆里纠正。`;
  const options = c.role.personality === '理性坦诚' ? ['嗯，我听着。你最在意的是哪一件事？', '这句我还没完全理解，你愿意多说一点吗？', '先说说你的想法，我听着。']
    : c.role.personality === '活泼有趣' ? ['说吧，今天有什么想分享的？开心的、烦恼的都行。', '我在呢，你接着说。', '这句我没跟上，能再讲一点吗？']
    : ['嗯，你慢慢说，我在听。', '我在呢，你接着说。', '刚才我没听明白，你愿意再说一点吗？'];
  const last = [...c.messages].reverse().find(m => m.speaker === 'assistant')?.text;
  // Fixed fixtures remain visibly demo-only. Avoid the same catch-all reply
  // on consecutive turns; this is NOT an attempt to simulate model inference.
  const offset = c.messages.filter(m => m.speaker === 'assistant').length % options.length;
  return options.slice(offset).concat(options.slice(0, offset)).find(v => v !== last) ?? options[0]!;
}
