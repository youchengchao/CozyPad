import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgyReply, AgyThinkingCard } from '../src/workspaces/agents/AgyReply';

const noop = () => undefined;

describe('AgyReply', () => {
  it('collapses the agent reasoning behind its duration', () => {
    const html = renderToStaticMarkup(
      <AgyThinkingCard
        meta="2s"
        title="The user is just saying hi. I'll respond with a friendly greeting."
      />,
    );

    // Closed by default: a `<details open>` here is the old behaviour, where
    // the reasoning sat permanently above the answer.
    expect(html).toContain('<details');
    expect(html).not.toContain('open=""');
    // The label is what stays visible.
    expect(html).toContain('Thought for 2s');
    // The reasoning is the disclosed content, not the summary.
    expect(html).toContain('agy-thinking-body');
    expect(html).toContain('just saying hi');
    expect(html.indexOf('</summary>')).toBeLessThan(
      html.indexOf('just saying hi'),
    );
  });

  it('names the disclosure sensibly when AGY reports no duration', () => {
    const html = renderToStaticMarkup(<AgyThinkingCard meta="" title="" />);

    expect(html).toContain('Thought');
    expect(html).not.toContain('Thought for');
    expect(html).not.toContain('agy-thinking-body');
  });

  it('renders reasoning, tools and prose as separate blocks of one reply', () => {
    const html = renderToStaticMarkup(
      <AgyReply
        streaming={false}
        onToggleToolDetails={noop}
        text={[
          '▸ Thought for 3s, 740 tokens',
          'Designing the quiz interface',
          '● ListDir(/home/devbox)',
          '',
          'Here is the plan.',
        ].join('\n')}
      />,
    );

    expect(html).toContain('Thought for 3s, 740 tokens');
    expect(html).toContain('Designing the quiz interface');
    expect(html).toContain('ListDir');
    expect(html).toContain('Here is the plan.');
    // Prose is body copy, not a bubble — the same markup ChatTimeline uses.
    expect(html).toContain('msg msg-assistant');
  });

  it("marks AGY's own notice as coming from the CLI, not the model", () => {
    const html = renderToStaticMarkup(
      <AgyReply
        streaming={false}
        onToggleToolDetails={noop}
        text={[
          'Done.',
          '⚠ Conversation already open',
          '⎿  It was already open in another CLI instance on this machine.',
        ].join('\n')}
      />,
    );

    expect(html).toContain('agy-notice-card');
    expect(html).toContain('Conversation already open');
    expect(html).toContain('AGY CLI');
    // Never inside an assistant message — that is the whole point.
    const notice = html.indexOf('agy-notice-card');
    const assistant = html.indexOf('msg msg-assistant');
    expect(notice).toBeGreaterThan(-1);
    expect(html.slice(assistant, notice)).not.toContain('Conversation already open');
  });

  it('shows the streaming caret only on the last block while streaming', () => {
    const text = 'Working on it';

    expect(
      renderToStaticMarkup(
        <AgyReply streaming onToggleToolDetails={noop} text={text} />,
      ),
    ).toContain('class="caret"');
    expect(
      renderToStaticMarkup(
        <AgyReply streaming={false} onToggleToolDetails={noop} text={text} />,
      ),
    ).not.toContain('class="caret"');
  });

  it('omits the native tool control in the read-only transcript preview', () => {
    const text = '● ListDir(/home/devbox)';

    expect(
      renderToStaticMarkup(
        <AgyReply streaming={false} onToggleToolDetails={noop} text={text} />,
      ),
    ).toContain('agy-tool-native-view');
    expect(
      renderToStaticMarkup(
        <AgyReply
          streaming={false}
          onToggleToolDetails={noop}
          showNativeToolControl={false}
          text={text}
        />,
      ),
    ).not.toContain('agy-tool-native-view');
  });
});
