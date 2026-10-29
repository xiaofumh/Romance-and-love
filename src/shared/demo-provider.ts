import type { ModelOutput } from './contracts';
import type { ProviderContext } from '../server/service';

// Local-only fixtures, never described as real model inference or content moderation.
export function demoOutput(c: ProviderContext, variant = 0): ModelOutput {
  const i = c.input;
  const sets: Record<string, string[]> = {
    daily: ['我看到你的消息了。你最在意的是哪一部分？我想先听你说清楚。', '我想认真回应你，也想先确认一下：你希望我解释情况，还是一起想办法？', '谢谢你直接告诉我。我们把具体的事情说开，好吗？'],
    relationship: ['我理解这件事让你不好受。我想先听听，你最在意的是什么？', '我在意你的感受，也想把彼此的想法说清楚，避免继续误会。', '我们可以慢慢说。我想先确认你的意思，再认真回应。'],
    work: ['收到。为避免理解偏差，想先确认优先级和预期交付标准，再给您准确答复。', '感谢说明。我会先核对相关信息；目前还不能确认的部分，想请您补充一下。', '这件事我理解了。我们先把目标、边界和时间要求对齐，再确定下一步。'],
    customer: ['您好，感谢反馈。请您补充具体情况，我先核实，再向您说明处理方案。', '理解您的关注。为避免给您不准确的承诺，我们先确认实际情况和可行的安排。', '谢谢您的说明。我们会围绕您提出的问题沟通，未核实的结果暂不作保证。'],
  };
  let texts = sets[i.scene] ?? sets.daily!;
  if (/不想理|不回|回复慢/.test(i.message) && /开会/.test(i.background)) texts = [
    '刚才在开会，回复慢了，抱歉。不是不想理你，我想先把这件事解释清楚。',
    '刚才开会没及时回复，让你误会了。你愿意说说刚才的感受吗？',
    '我看到你说的话了。刚才在开会，所以回复晚了；我不想让你一直猜。',
  ];
  // A curated example fixture, not general intent recognition.
  if (i.message === '周末你一定要陪我去，我都答应别人了。' && i.background === '我不想参加这次活动。') texts = [
    '谢谢你想到我，不过这次活动我不参加。以后替我答应之前，可以先问问我吗？',
    '我知道你已经答应别人了，但这次我不想参加，不能答应陪你去。希望你尊重我的决定。',
    '这次我就不去了。你可以按自己的意愿安排，但请不要替我作决定。',
  ];
  if (i.tone === 'firm') texts = texts.map(t => `我愿意沟通，也希望我们尊重彼此的边界。${t}`);
  if (i.length === 'medium') texts = texts.map(t => `${t}如果还有我没理解的地方，可以直接告诉我，我们一起把问题说清楚。`);
  const offset = Math.abs(variant) % 3;
  return { replies: texts.map((_, n) => ({ text: texts[(n + offset) % 3]! })),
    warnings: ['当前为本地通用模板演示，不是真实模型回复；未分析输入中的全部背景、目标和记忆。'] };
}
