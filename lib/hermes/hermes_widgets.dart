part of ssh_dashboard;

class _HermesMemoryTargetCard extends StatelessWidget {
  final HermesMemoryTargetState state;
  final String description;
  final ValueChanged<String> onReplace;
  final ValueChanged<String> onRemove;

  const _HermesMemoryTargetCard({
    required this.state,
    required this.description,
    required this.onReplace,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final usageColor = state.usedChars > state.limit
        ? AppPalette.danger
        : state.isNearCapacity
            ? AppPalette.warning
            : AppPalette.success;
    return Card(
      color: AppPalette.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: AppPalette.border),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(state.target == 'user' ? Icons.person_outline : Icons.article_outlined, color: AppPalette.accent),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    state.fileName,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800, color: AppPalette.textPrimary),
                  ),
                ),
                Chip(
                  label: Text('${state.usedChars}/${state.limit} chars (${state.percent}%)', style: const TextStyle(fontSize: 11)),
                  visualDensity: VisualDensity.compact,
                  backgroundColor: AppPalette.backgroundDeep,
                  side: BorderSide(color: usageColor.withOpacity(0.35)),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(description, style: TextStyle(color: AppPalette.textMuted, fontSize: 12)),
            const SizedBox(height: 12),
            if (state.entries.isEmpty)
              Text('No entries yet.', style: TextStyle(color: AppPalette.textMuted))
            else
              ...state.entries.map(
                (entry) => Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppPalette.backgroundDeep,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppPalette.border),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SelectableText(entry, style: Theme.of(context).textTheme.bodyMedium?.copyWith(height: 1.35, color: AppPalette.textPrimary)),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        children: [
                          ActionChip(
                            avatar: const Icon(Icons.edit, size: 14, color: AppPalette.textSecondary),
                            label: const Text('Replace', style: TextStyle(fontSize: 11)),
                            backgroundColor: AppPalette.surfaceSoft,
                            side: const BorderSide(color: AppPalette.border),
                            onPressed: () => onReplace(entry),
                          ),
                          ActionChip(
                            avatar: const Icon(Icons.delete_outline, size: 14, color: AppPalette.danger),
                            label: const Text('Remove', style: TextStyle(fontSize: 11, color: AppPalette.danger)),
                            backgroundColor: AppPalette.surfaceSoft,
                            side: const BorderSide(color: AppPalette.border),
                            onPressed: () => onRemove(entry),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _HermesMessageCard extends StatelessWidget {
  final HermesMessage message;
  final ValueChanged<String>? onUseSuggestion;
  final void Function(String tool, Map<String, dynamic> args)? onApprove;

  const _HermesMessageCard({
    required this.message,
    this.onUseSuggestion,
    this.onApprove,
  });

  @override
  Widget build(BuildContext context) {
    if (message.role == 'tool') {
      return _HermesTraceMessageCard(message: message, onApprove: onApprove);
    }

    final isUser = message.role == 'user';
    final isSystem = message.role == 'system';
    
    final color = isUser
        ? AppPalette.surfaceSoft
        : isSystem
            ? const Color(0xFF1E1416)
            : AppPalette.surface;
            
    final borderColor = isUser
        ? AppPalette.borderStrong
        : isSystem
            ? AppPalette.danger.withOpacity(0.3)
            : AppPalette.border;

    final align = isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start;
    final icon = isUser ? Icons.person_outline : isSystem ? Icons.error_outline : Icons.auto_awesome;
    final iconColor = isUser ? AppPalette.accentSoft : isSystem ? AppPalette.danger : AppPalette.success;
    final title = isUser ? 'You' : isSystem ? 'System' : 'Hermes';

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: align,
        children: [
          Container(
            constraints: const BoxConstraints(maxWidth: 880),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: color,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: borderColor),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withOpacity(0.12),
                  blurRadius: 10,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(icon, size: 15, color: iconColor),
                    const SizedBox(width: 6),
                    Text(
                      title,
                      style: Theme.of(context).textTheme.labelMedium?.copyWith(color: AppPalette.textSecondary, fontWeight: FontWeight.w800),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                for (final part in message.parts)
                  _HermesMessagePartView(part: part, onUseSuggestion: onUseSuggestion, onApprove: onApprove),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _HermesTraceMessageCard extends StatelessWidget {
  final HermesMessage message;
  final void Function(String tool, Map<String, dynamic> args)? onApprove;

  const _HermesTraceMessageCard({required this.message, this.onApprove});

  @override
  Widget build(BuildContext context) {
    final isResult = message.parts.any((part) => part.type == 'tool_result');
    final title = isResult ? 'Tool result / observation' : 'Tool call proposed';
    final iconColor = isResult ? AppPalette.success : AppPalette.warning;
    final icon = isResult ? Icons.analytics_outlined : Icons.terminal_outlined;

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        decoration: BoxDecoration(
          color: AppPalette.backgroundDeep,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppPalette.border),
        ),
        child: Theme(
          data: Theme.of(context).copyWith(
            dividerColor: Colors.transparent,
          ),
          child: ExpansionTile(
            tilePadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 2),
            childrenPadding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
            shape: const Border(),
            collapsedShape: const Border(),
            leading: Icon(icon, color: iconColor, size: 18),
            title: Text(
              title,
              style: Theme.of(context).textTheme.labelLarge?.copyWith(
                fontWeight: FontWeight.w800,
                color: AppPalette.textPrimary,
              ),
            ),
            subtitle: Text(
              isResult ? 'Observation captured from runtime' : 'Pending harness security review',
              style: const TextStyle(color: AppPalette.textMuted, fontSize: 11),
            ),
            children: [
              for (final part in message.parts) _HermesMessagePartView(part: part, onApprove: onApprove),
            ],
          ),
        ),
      ),
    );
  }
}

class _HermesMessagePartView extends StatelessWidget {
  final HermesMessagePart part;
  final ValueChanged<String>? onUseSuggestion;
  final void Function(String tool, Map<String, dynamic> args)? onApprove;

  const _HermesMessagePartView({
    required this.part,
    this.onUseSuggestion,
    this.onApprove,
  });

  @override
  Widget build(BuildContext context) {
    if (part.type == 'tool_call') {
      return _ToolBox(
        title: 'Tool requested: ${part.metadata['tool'] ?? '-'}',
        subtitle: part.text,
        body: const JsonEncoder.withIndent('  ').convert(part.metadata['args'] ?? {}),
        icon: Icons.play_circle,
        color: Colors.orangeAccent,
        toolName: part.metadata['tool']?.toString(),
        toolArgs: part.metadata['args'] is Map ? Map<String, dynamic>.from(part.metadata['args'] as Map) : null,
        onApprove: onApprove,
      );
    }
    if (part.type == 'tool_result') {
      final ok = part.metadata['ok'] == true;
      return _ToolBox(
        title: 'Tool result: ${part.metadata['tool'] ?? '-'} ${ok ? '(ok)' : '(failed)'}',
        subtitle: ok ? 'Observation recorded in session.' : 'Tool returned an error or was blocked.',
        body: part.text,
        icon: ok ? Icons.check_circle : Icons.block,
        color: ok ? Colors.greenAccent : Colors.redAccent,
      );
    }
    if (part.type == 'clarification') {
      return _ClarificationBox(part: part, onUseSuggestion: onUseSuggestion);
    }
    if (part.type == 'trace') {
      return _TraceToggle(
        text: part.text,
        kind: part.metadata['kind']?.toString() ?? 'model_visible_notes',
      );
    }
    if (part.type == 'error') {
      return SelectableText(part.text, style: const TextStyle(color: Colors.redAccent));
    }
    return _HermesMarkdownContent(
      data: part.text,
      textColor: Colors.white.withOpacity(0.92),
      codeBlockColor: const Color(0xFF020617),
    );
  }
}

class _HermesMarkdownContent extends StatelessWidget {
  final String data;
  final Color? textColor;
  final Color? codeBlockColor;

  const _HermesMarkdownContent({
    required this.data,
    this.textColor,
    this.codeBlockColor,
  });

  @override
  Widget build(BuildContext context) {
    final segments = _splitDisplayMath(data);
    if (segments.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final segment in segments)
          if (segment.isMath)
            _HermesDisplayMathBlock(tex: segment.text)
          else if (segment.text.trim().isNotEmpty)
            _HermesMarkdownBody(
              data: segment.text,
              textColor: textColor,
              codeBlockColor: codeBlockColor,
            ),
      ],
    );
  }

  static List<_HermesMarkdownSegment> _splitDisplayMath(String source) {
    final text = source.trimRight();
    if (text.trim().isEmpty) return const [];

    final pattern = RegExp(r'(\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])');
    final segments = <_HermesMarkdownSegment>[];
    var cursor = 0;

    for (final match in pattern.allMatches(text)) {
      if (match.start > cursor) {
        segments.add(_HermesMarkdownSegment.markdown(text.substring(cursor, match.start)));
      }
      final math = match.group(2) ?? match.group(3) ?? '';
      segments.add(_HermesMarkdownSegment.math(math.trim()));
      cursor = match.end;
    }

    if (cursor < text.length) {
      segments.add(_HermesMarkdownSegment.markdown(text.substring(cursor)));
    }

    return segments;
  }
}

class _HermesMarkdownSegment {
  final String text;
  final bool isMath;

  const _HermesMarkdownSegment._(this.text, this.isMath);
  const _HermesMarkdownSegment.markdown(String text) : this._(text, false);
  const _HermesMarkdownSegment.math(String text) : this._(text, true);
}

class _HermesMarkdownBody extends StatelessWidget {
  final String data;
  final Color? textColor;
  final Color? codeBlockColor;

  const _HermesMarkdownBody({
    required this.data,
    this.textColor,
    this.codeBlockColor,
  });

  @override
  Widget build(BuildContext context) {
    final base = Theme.of(context).textTheme.bodyMedium?.copyWith(
          color: textColor ?? Colors.white.withOpacity(0.92),
          height: 1.42,
        );
    final small = Theme.of(context).textTheme.bodySmall?.copyWith(
          color: (textColor ?? Colors.white).withOpacity(0.74),
          height: 1.35,
        );

    return MarkdownBody(
      data: data,
      selectable: true,
      extensionSet: md.ExtensionSet.gitHubFlavored,
      inlineSyntaxes: [
        _HermesDollarMathSyntax(),
        _HermesParenMathSyntax(),
      ],
      builders: {
        'latex': _HermesInlineLatexBuilder(),
      },
      styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
        p: base,
        strong: base?.copyWith(fontWeight: FontWeight.w800),
        em: base?.copyWith(fontStyle: FontStyle.italic),
        h1: Theme.of(context).textTheme.titleLarge?.copyWith(
              color: textColor ?? Colors.white,
              fontWeight: FontWeight.w900,
            ),
        h2: Theme.of(context).textTheme.titleMedium?.copyWith(
              color: textColor ?? Colors.white,
              fontWeight: FontWeight.w900,
            ),
        h3: Theme.of(context).textTheme.titleSmall?.copyWith(
              color: textColor ?? Colors.white,
              fontWeight: FontWeight.w900,
            ),
        listBullet: base,
        blockquote: small,
        blockquoteDecoration: BoxDecoration(
          color: Colors.white.withOpacity(0.045),
          borderRadius: BorderRadius.circular(10),
          border: Border(left: BorderSide(color: AppPalette.accent.withOpacity(0.35), width: 3)),
        ),
        code: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: AppPalette.accent.withOpacity(0.96),
              fontFamily: 'monospace',
              backgroundColor: Colors.white.withOpacity(0.06),
            ),
        codeblockDecoration: BoxDecoration(
          color: codeBlockColor ?? const Color(0xFF020617),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppPalette.border),
        ),
        codeblockPadding: const EdgeInsets.all(12),
        tableHead: base?.copyWith(fontWeight: FontWeight.w900),
        tableBody: base,
        tableBorder: TableBorder.all(color: AppPalette.border),
        horizontalRuleDecoration: BoxDecoration(
          border: Border(top: BorderSide(color: Colors.white.withOpacity(0.16))),
        ),
        a: base?.copyWith(
          color: AppPalette.accent,
          decoration: TextDecoration.underline,
        ),
      ),
    );
  }
}

class _HermesDollarMathSyntax extends md.InlineSyntax {
  _HermesDollarMathSyntax() : super(r'(?<!\\)\$(?!\$)(.+?)(?<!\\)\$(?!\$)', startCharacter: r'$'.codeUnitAt(0));

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final tex = match.group(1)?.trim() ?? '';
    if (tex.isEmpty) return false;
    parser.addNode(md.Element.text('latex', tex));
    return true;
  }
}

class _HermesParenMathSyntax extends md.InlineSyntax {
  _HermesParenMathSyntax() : super(r'\\\((.+?)\\\)');

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final tex = match.group(1)?.trim() ?? '';
    if (tex.isEmpty) return false;
    parser.addNode(md.Element.text('latex', tex));
    return true;
  }
}

class _HermesInlineLatexBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) {
    final tex = element.textContent.trim();
    if (tex.isEmpty) return const SizedBox.shrink();
    return _HermesMathTex(tex: tex, inline: true, textStyle: preferredStyle);
  }
}

class _HermesDisplayMathBlock extends StatelessWidget {
  final String tex;

  const _HermesDisplayMathBlock({required this.tex});

  @override
  Widget build(BuildContext context) {
    if (tex.trim().isEmpty) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.045),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppPalette.accent.withOpacity(0.22)),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: _HermesMathTex(
          tex: tex.trim(),
          inline: false,
          textStyle: Theme.of(context).textTheme.bodyLarge?.copyWith(color: Colors.white.withOpacity(0.94)),
        ),
      ),
    );
  }
}

class _HermesMathTex extends StatelessWidget {
  final String tex;
  final bool inline;
  final TextStyle? textStyle;

  const _HermesMathTex({
    required this.tex,
    required this.inline,
    this.textStyle,
  });

  @override
  Widget build(BuildContext context) {
    try {
      return Math.tex(
        tex,
        textStyle: textStyle ?? Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white.withOpacity(0.92)),
        mathStyle: inline ? MathStyle.text : MathStyle.display,
      );
    } catch (_) {
      return SelectableText(
        inline ? r'$' + tex + r'$' : r'$$' + tex + r'$$',
        style: (textStyle ?? Theme.of(context).textTheme.bodyMedium)?.copyWith(
          color: Colors.orangeAccent,
          fontFamily: 'monospace',
        ),
      );
    }
  }
}

class _TraceToggle extends StatelessWidget {
  final String text;
  final String kind;

  const _TraceToggle({required this.text, this.kind = 'model_visible_notes'});

  @override
  Widget build(BuildContext context) {
    if (text.trim().isEmpty) return const SizedBox.shrink();
    final isTool = kind == 'tool_events';
    final title = isTool ? 'Tool events' : 'Reasoning / notes';
    final subtitle = isTool
        ? 'Generated locally from actual dashboard tool calls.'
        : 'Captured only if the model accidentally printed pre-answer notes; no extra summary request is sent.';
    final icon = isTool ? Icons.route : Icons.psychology_alt;
    final color = isTool ? Colors.orangeAccent : AppPalette.accent;
    return Container(
      margin: const EdgeInsets.only(top: 10),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.035),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppPalette.border),
      ),
      child: ExpansionTile(
        tilePadding: const EdgeInsets.symmetric(horizontal: 10),
        childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        leading: Icon(icon, size: 18, color: color),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w800)),
        subtitle: Text(subtitle, style: const TextStyle(color: Colors.white54, fontSize: 12)),
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: _HermesMarkdownContent(
              data: text,
              textColor: Colors.white70,
              codeBlockColor: const Color(0xFF020617),
            ),
          ),
        ],
      ),
    );
  }
}

class _ClarificationBox extends StatelessWidget {
  final HermesMessagePart part;
  final ValueChanged<String>? onUseSuggestion;

  const _ClarificationBox({
    required this.part,
    this.onUseSuggestion,
  });

  List<String> get options {
    final optionsRaw = part.metadata['options'];
    return optionsRaw is List
        ? optionsRaw.map((item) => item.toString()).where((item) => item.trim().isNotEmpty).toList()
        : <String>[];
  }

  @override
  Widget build(BuildContext context) {
    final currentOptions = options;
    return Container(
      margin: const EdgeInsets.only(top: 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppPalette.accent.withOpacity(0.07),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: AppPalette.accent.withOpacity(0.32),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.question_answer, size: 18, color: AppPalette.accent),
              const SizedBox(width: 8),
              Text('Hermes clarification request', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w900)),
            ],
          ),
          const SizedBox(height: 10),
          _HermesMarkdownContent(
            data: part.text,
            textColor: Colors.white.withOpacity(0.92),
            codeBlockColor: const Color(0xFF020617),
          ),
          if (currentOptions.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (var index = 0; index < currentOptions.length; index++)
                  ActionChip(
                    label: Text(currentOptions[index]),
                    avatar: const Icon(
                      Icons.reply,
                      size: 16,
                      color: AppPalette.accent,
                    ),
                    onPressed: onUseSuggestion == null
                        ? null
                        : () => onUseSuggestion!(currentOptions[index]),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _ToolBox extends StatelessWidget {
  final String title;
  final String subtitle;
  final String body;
  final IconData icon;
  final Color color;
  final String? toolName;
  final Map<String, dynamic>? toolArgs;
  final void Function(String tool, Map<String, dynamic> args)? onApprove;

  const _ToolBox({
    required this.title,
    required this.subtitle,
    required this.body,
    required this.icon,
    required this.color,
    this.toolName,
    this.toolArgs,
    this.onApprove,
  });

  @override
  Widget build(BuildContext context) {
    // Check if this tool is mutating and requires approval
    final isMutating = toolName != null &&
        (toolName == 'ssh.run_approved' ||
         toolName == 'file.write_text' ||
         toolName == 'task.launch' ||
         toolName == 'task.cancel' ||
         toolName == 'remote.tmux.start' ||
         toolName == 'remote.tmux.send' ||
         toolName == 'remote.tmux.stop');

    return Container(
      margin: const EdgeInsets.only(top: 6),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withOpacity(0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withOpacity(0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: color, size: 17),
              const SizedBox(width: 8),
              Expanded(child: Text(title, style: TextStyle(color: color, fontWeight: FontWeight.w800))),
            ],
          ),
          if (subtitle.trim().isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(subtitle, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white70)),
          ],
          if (body.trim().isNotEmpty) ...[
            const SizedBox(height: 8),
            SelectableText(body, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white70, fontFamily: 'monospace')),
          ],
          if (onApprove != null && toolName != null && toolArgs != null && isMutating) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                ElevatedButton.icon(
                  onPressed: () => onApprove!(toolName!, toolArgs!),
                  icon: const Icon(Icons.check_circle_outline, size: 14, color: Colors.greenAccent),
                  label: const Text('Approve & Execute Tool', style: TextStyle(fontSize: 11, color: Colors.greenAccent)),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.greenAccent.withOpacity(0.08),
                    shadowColor: Colors.transparent,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                      side: BorderSide(color: Colors.greenAccent.withOpacity(0.3)),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _HermesSidebar extends StatelessWidget {
  final _HermesStudioSection selected;
  final String profile;
  final bool isRunning;
  final ValueChanged<_HermesStudioSection> onSelect;
  final VoidCallback onNewSession;

  const _HermesSidebar({
    required this.selected,
    required this.profile,
    required this.isRunning,
    required this.onSelect,
    required this.onNewSession,
  });

  @override
  Widget build(BuildContext context) {
    final items = [
      (_HermesStudioSection.overview, Icons.dashboard, 'Overview'),
      (_HermesStudioSection.session, Icons.chat, 'Session'),
      (_HermesStudioSection.memory, Icons.psychology_alt, 'Memory'),
      (_HermesStudioSection.skills, Icons.construction, 'Skills'),
      (_HermesStudioSection.automations, Icons.schedule, 'Automations'),
      (_HermesStudioSection.gateways, Icons.hub, 'Remote Runtime'),
      (_HermesStudioSection.profiles, Icons.account_tree, 'Profiles'),
      (_HermesStudioSection.dlOps, Icons.memory, 'DL Ops'),
      (_HermesStudioSection.security, Icons.security, 'Security'),
      (_HermesStudioSection.settings, Icons.tune, 'Settings'),
    ];

    return Container(
      color: AppPalette.backgroundDeep,
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.auto_awesome, color: AppPalette.accent),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Hermes Studio',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w900,
                    color: AppPalette.textPrimary,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'dashboard-native agent kernel · $profile',
            style: const TextStyle(color: AppPalette.textMuted, fontSize: 11),
          ),
          const SizedBox(height: 14),
          _HermesMiniStatus(
            title: isRunning ? 'Engine running' : 'Engine idle',
            subtitle: 'No external hermes executable',
            color: isRunning ? Colors.orangeAccent : Colors.greenAccent,
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: onNewSession,
              icon: const Icon(Icons.add, size: 18),
              label: const Text('New session'),
              style: FilledButton.styleFrom(
                backgroundColor: AppPalette.accent,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ),
          const SizedBox(height: 14),
          Expanded(
            child: ListView(
              children: [
                for (final item in items)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 5),
                    child: ListTile(
                      dense: true,
                      selected: selected == item.$1,
                      selectedTileColor: AppPalette.accent.withOpacity(0.08),
                      selectedColor: AppPalette.accent,
                      textColor: AppPalette.textSecondary,
                      iconColor: AppPalette.textMuted,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                      leading: Icon(item.$2, size: 18),
                      title: Text(item.$3, style: const TextStyle(fontWeight: FontWeight.w600)),
                      onTap: () => onSelect(item.$1),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _HermesTopBar extends StatelessWidget {
  final String? connectedHost;
  final String profile;
  final String project;
  final String status;
  final bool isRunning;
  final VoidCallback onRefreshResources;
  final VoidCallback onSendGpuContext;

  const _HermesTopBar({
    required this.connectedHost,
    required this.profile,
    required this.project,
    required this.status,
    required this.isRunning,
    required this.onRefreshResources,
    required this.onSendGpuContext,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      color: AppPalette.surface,
      child: Row(
        children: [
          _HermesPill(icon: Icons.account_tree_outlined, label: 'Profile: $profile'),
          const SizedBox(width: 8),
          _HermesPill(icon: Icons.folder_open, label: 'Project: $project'),
          const SizedBox(width: 8),
          _HermesPill(icon: Icons.dns_outlined, label: 'SSH target: ${connectedHost ?? '-'}'),
          const SizedBox(width: 8),
          _HermesPill(
            icon: isRunning ? Icons.play_circle_outline : Icons.pause_circle_outline, 
            label: isRunning ? 'turn running' : 'idle',
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              status,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: AppPalette.textMuted, fontSize: 11),
            ),
          ),
          IconButton(
            tooltip: 'Refresh remote resource snapshot',
            onPressed: onRefreshResources,
            icon: const Icon(Icons.refresh, size: 20),
            color: AppPalette.textSecondary,
          ),
          const SizedBox(width: 4),
          FilledButton.tonalIcon(
            onPressed: onSendGpuContext,
            icon: const Icon(Icons.memory, size: 16),
            label: const Text('GPU question', style: TextStyle(fontSize: 12)),
            style: FilledButton.styleFrom(
              backgroundColor: AppPalette.surfaceSoft,
              foregroundColor: AppPalette.textPrimary,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            ),
          ),
        ],
      ),
    );
  }
}

class _HermesSwitchLine extends StatelessWidget {
  final bool value;
  final String title;
  final String subtitle;
  final ValueChanged<bool> onChanged;

  const _HermesSwitchLine({
    required this.value,
    required this.title,
    required this.subtitle,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      value: value,
      contentPadding: EdgeInsets.zero,
      dense: true,
      title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
      subtitle: Text(subtitle, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white60)),
      onChanged: onChanged,
    );
  }
}

class _HermesPanel extends StatelessWidget {
  final String title;
  final IconData icon;
  final Widget child;

  const _HermesPanel({
    required this.title,
    required this.icon,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      color: const Color(0xFF111827),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: const BorderSide(color: AppPalette.border),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, color: AppPalette.accent, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    title,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            child,
          ],
        ),
      ),
    );
  }
}

class _HermesFeatureCard extends StatelessWidget {
  final _HermesFeatureSpec spec;

  const _HermesFeatureCard({required this.spec});

  @override
  Widget build(BuildContext context) {
    final color = spec.status == 'implemented'
        ? Colors.greenAccent
        : spec.status == 'partial'
            ? Colors.orangeAccent
            : Colors.white54;
    return Card(
      color: const Color(0xFF111827),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: AppPalette.border),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(spec.icon, color: AppPalette.accent),
                const SizedBox(width: 8),
                Expanded(child: Text(spec.title, style: const TextStyle(fontWeight: FontWeight.w800))),
                Chip(label: Text(spec.status), visualDensity: VisualDensity.compact, side: BorderSide(color: color.withOpacity(0.5))),
              ],
            ),
            const SizedBox(height: 8),
            Expanded(
              child: Text(
                spec.description,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white70),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _HermesPill extends StatelessWidget {
  final IconData icon;
  final String label;

  const _HermesPill({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: AppPalette.accent.withOpacity(0.08),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppPalette.accent.withOpacity(0.22)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 15, color: AppPalette.accent),
          const SizedBox(width: 6),
          Text(label, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: Colors.white70)),
        ],
      ),
    );
  }
}

class _HermesCheckLine extends StatelessWidget {
  final String text;

  const _HermesCheckLine({required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.check_circle, size: 17, color: Colors.greenAccent),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: const TextStyle(color: Colors.white70))),
        ],
      ),
    );
  }
}

class _HermesMiniStatus extends StatelessWidget {
  final String title;
  final String subtitle;
  final Color color;

  const _HermesMiniStatus({
    required this.title,
    required this.subtitle,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: color.withOpacity(0.10),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: color.withOpacity(0.35)),
      ),
      child: Row(
        children: [
          Icon(Icons.circle, size: 13, color: color),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: TextStyle(color: color, fontWeight: FontWeight.w800)),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white60),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TerminalStatusChip extends StatelessWidget {
  final bool connected;
  final bool connecting;
  final String text;

  const _TerminalStatusChip({
    required this.connected,
    required this.connecting,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    final color = connecting
        ? Colors.orangeAccent
        : connected
            ? Colors.greenAccent
            : Colors.redAccent;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: color.withOpacity(0.14),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withOpacity(0.4)),
      ),
      child: Row(
        children: [
          Icon(
            connecting
                ? Icons.sync
                : connected
                    ? Icons.check_circle
                    : Icons.error,
            color: color,
            size: 16,
          ),
          const SizedBox(width: 6),
          Text(
            text,
            style: TextStyle(color: color),
          ),
        ],
      ),
    );
  }
}

