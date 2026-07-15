part of cozypad;

/* =========================================================
   Files Tab: remote file browser
========================================================= */

enum _RemoteClipboardMode { copy, move }

class _RemoteClipboardEntry {
  final RemoteFileItem item;
  final _RemoteClipboardMode mode;

  const _RemoteClipboardEntry({
    required this.item,
    required this.mode,
  });

  String get actionLabel => mode == _RemoteClipboardMode.copy ? 'Copy' : 'Move';
  String get pasteLabel => mode == _RemoteClipboardMode.copy ? 'Paste copy' : 'Paste move';
  IconData get icon => mode == _RemoteClipboardMode.copy ? Icons.content_copy_outlined : Icons.drive_file_move_outlined;
}

class FilesTab extends StatefulWidget {
  const FilesTab({super.key});

  @override
  State<FilesTab> createState() => _FilesTabState();
}

class _FilesTabState extends State<FilesTab> with AutomaticKeepAliveClientMixin<FilesTab> {
  int get _maxTextPreviewBytes => (MediaQuery.of(context).size.width < 760) ? 128 * 1024 : 2 * 1024 * 1024;
  int get _maxImagePreviewBytes => (MediaQuery.of(context).size.width < 760) ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
  int get _maxVideoPreviewBytes => (MediaQuery.of(context).size.width < 760) ? 15 * 1024 * 1024 : 80 * 1024 * 1024;

  final TextEditingController pathController = TextEditingController(text: '~');
  final TextEditingController editorController = TextEditingController();

  RemoteDirectoryListing? listing;
  bool directoryLoading = false;
  bool previewLoading = false;
  bool initialized = false;
  String? error;
  RemoteFilePreviewData preview = const RemoteFilePreviewData.empty();
  _RemoteClipboardEntry? remoteClipboard;
  bool fileOperationRunning = false;
  bool editorDirty = false;
  bool editorSaving = false;
  bool _suppressEditorDirty = false;
  RemoteFileItem? editorItem;
  int _currentOffset = 0;
  String _originalText = '';
  bool _showEditorInsteadOfPreview = false;
  bool _showFindBar = false;
  bool _showReplace = false;
  final TextEditingController _findController = TextEditingController();
  final TextEditingController _replaceController = TextEditingController();
  final ScrollController _editorScrollController = ScrollController();
  final ScrollController _lineScrollController = ScrollController();
  List<int> _findMatchOffsets = [];
  int _currentMatchIndex = -1;

  bool get _canEditCurrentPreview {
    final kind = preview.kind;
    final item = editorItem;
    if (item == null || preview.truncated) return false;
    if (kind == RemoteFilePreviewKind.text || kind == RemoteFilePreviewKind.markdown) return true;
    if (kind == RemoteFilePreviewKind.spreadsheet) {
      final ext = _extensionOf(item.name);
      return ext == 'csv' || ext == 'tsv';
    }
    return false;
  }

  @override
  void initState() {
    super.initState();
    editorController.addListener(_handleEditorChanged);
    _findController.addListener(() {
      _performFind(_findController.text);
    });
    _editorScrollController.addListener(() {
      if (_lineScrollController.hasClients) {
        _lineScrollController.jumpTo(_editorScrollController.offset);
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => openPath('~'));
  }

  @override
  void dispose() {
    pathController.dispose();
    editorController.removeListener(_handleEditorChanged);
    editorController.dispose();
    _findController.dispose();
    _replaceController.dispose();
    _editorScrollController.dispose();
    _lineScrollController.dispose();
    super.dispose();
  }

  void _handleEditorChanged() {
    if (_suppressEditorDirty || editorItem == null) return;
    final isDirty = editorController.text != _originalText;
    if (editorDirty != isDirty) {
      setState(() {
        editorDirty = isDirty;
      });
    }
  }

  void _setEditorText(RemoteFileItem item, String text) {
    _suppressEditorDirty = true;
    editorController.text = text;
    editorController.selection = const TextSelection.collapsed(offset: 0);
    _originalText = text;
    _suppressEditorDirty = false;
    editorItem = item;
    editorDirty = false;
    _showEditorInsteadOfPreview = false;
    _showFindBar = false;
    _showReplace = false;
    _findController.clear();
    _replaceController.clear();
    _findMatchOffsets = [];
    _currentMatchIndex = -1;
    if (_editorScrollController.hasClients) {
      _editorScrollController.jumpTo(0);
    }
  }

  void _clearEditorState() {
    _suppressEditorDirty = true;
    editorController.clear();
    _originalText = '';
    _suppressEditorDirty = false;
    editorItem = null;
    editorDirty = false;
    editorSaving = false;
    _showEditorInsteadOfPreview = false;
    _showFindBar = false;
    _showReplace = false;
    _findController.clear();
    _replaceController.clear();
    _findMatchOffsets = [];
    _currentMatchIndex = -1;
    if (_editorScrollController.hasClients) {
      _editorScrollController.jumpTo(0);
    }
  }

  Future<bool> _confirmDiscardEditorChanges() async {
    if (!editorDirty) return true;
    final result = await showDialog<bool>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('Discard unsaved changes?'),
          content: Text('You have unsaved changes in ${editorItem?.name ?? 'this file'}. Continue without saving?'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton.tonal(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Discard'),
            ),
          ],
        );
      },
    );
    return result == true;
  }

  void _performFind(String query) {
    if (query.isEmpty) {
      setState(() {
        _findMatchOffsets = [];
        _currentMatchIndex = -1;
      });
      return;
    }
    final text = editorController.text;
    final matches = <int>[];
    var index = text.toLowerCase().indexOf(query.toLowerCase());
    while (index != -1) {
      matches.add(index);
      index = text.toLowerCase().indexOf(query.toLowerCase(), index + query.length);
    }
    setState(() {
      _findMatchOffsets = matches;
      if (matches.isNotEmpty) {
        _currentMatchIndex = 0;
        _selectAndScrollToMatch(matches[0], query.length);
      } else {
        _currentMatchIndex = -1;
      }
    });
  }

  void _findNext() {
    if (_findMatchOffsets.isEmpty) return;
    setState(() {
      _currentMatchIndex = (_currentMatchIndex + 1) % _findMatchOffsets.length;
      _selectAndScrollToMatch(_findMatchOffsets[_currentMatchIndex], _findController.text.length);
    });
  }

  void _findPrev() {
    if (_findMatchOffsets.isEmpty) return;
    setState(() {
      _currentMatchIndex = (_currentMatchIndex - 1 + _findMatchOffsets.length) % _findMatchOffsets.length;
      _selectAndScrollToMatch(_findMatchOffsets[_currentMatchIndex], _findController.text.length);
    });
  }

  void _selectAndScrollToMatch(int start, int length) {
    editorController.selection = TextSelection(
      baseOffset: start,
      extentOffset: start + length,
    );
  }

  void _performReplace() {
    if (_findMatchOffsets.isEmpty || _currentMatchIndex == -1) return;
    final matchOffset = _findMatchOffsets[_currentMatchIndex];
    final queryLen = _findController.text.length;
    final replaceText = _replaceController.text;
    final currentText = editorController.text;

    final newText = currentText.replaceRange(matchOffset, matchOffset + queryLen, replaceText);
    _suppressEditorDirty = true;
    editorController.text = newText;
    _suppressEditorDirty = false;
    setState(() {
      editorDirty = (newText != _originalText);
    });

    _performFind(_findController.text);
  }

  void _performReplaceAll() {
    final query = _findController.text;
    if (query.isEmpty) return;
    final replaceText = _replaceController.text;
    final currentText = editorController.text;
    final newText = currentText.replaceAll(query, replaceText);
    _suppressEditorDirty = true;
    editorController.text = newText;
    _suppressEditorDirty = false;
    setState(() {
      editorDirty = (newText != _originalText);
    });
    _performFind(query);
  }

  void _showGoToLineDialog(BuildContext context) {
    final lineController = TextEditingController();
    showDialog(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('Go to Line'),
          content: TextField(
            controller: lineController,
            keyboardType: TextInputType.number,
            autofocus: true,
            decoration: const InputDecoration(
              hintText: 'Line number',
            ),
            onSubmitted: (val) {
              final lineNum = int.tryParse(val);
              if (lineNum != null) {
                _goToLine(lineNum);
              }
              Navigator.pop(context);
            },
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () {
                final lineNum = int.tryParse(lineController.text);
                if (lineNum != null) {
                  _goToLine(lineNum);
                }
                Navigator.pop(context);
              },
              child: const Text('Go'),
            ),
          ],
        );
      },
    );
  }

  void _goToLine(int lineNum) {
    final text = editorController.text;
    final lines = text.split('\n');
    if (lineNum < 1 || lineNum > lines.length) return;
    var offset = 0;
    for (var i = 0; i < lineNum - 1; i++) {
      offset += lines[i].length + 1; // +1 for the newline
    }
    editorController.selection = TextSelection.collapsed(offset: offset);
  }

  void _showCommandPaletteDialog() {
    showDialog(
      context: context,
      builder: (context) {
        return _CommandPaletteDialog(
          commands: [
            _CommandItem(name: 'File: Save Current File', action: () => _saveCurrentEditor()),
            _CommandItem(
              name: 'File: Find Text',
              action: () => setState(() {
                _showFindBar = true;
              }),
            ),
            _CommandItem(
              name: 'File: Find & Replace',
              action: () => setState(() {
                _showFindBar = true;
                _showReplace = true;
              }),
            ),
            _CommandItem(name: 'File: Go to Line...', action: () => _showGoToLineDialog(context)),
            _CommandItem(name: 'File: Refresh File List', action: () => openPath(listing?.path ?? '~')),
            _CommandItem(name: 'Editor: Close Current File', action: () => _clearEditorState()),
          ],
        );
      },
    );
  }

  @override
  bool get wantKeepAlive => true;

  Future<void> openPath(
    String path, {
    bool confirmDiscard = true,
    bool clearPreview = true,
  }) async {
    if (directoryLoading) return;
    if (confirmDiscard && !await _confirmDiscardEditorChanges()) return;
    setState(() {
      directoryLoading = true;
      error = null;
      if (clearPreview) {
        preview = const RemoteFilePreviewData.empty();
        _clearEditorState();
      }
    });

    try {
      final next = await context.read<SSHProvider>().listRemoteDirectory(path);
      if (!mounted) return;
      setState(() {
        listing = next;
        pathController.text = next.path;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = e.toString();
      });
    } finally {
      if (mounted) {
        setState(() {
          directoryLoading = false;
          initialized = true;
        });
      }
    }
  }

  Future<void> openFile(RemoteFileItem item, {int offset = 0}) async {
    if (item.isDirectory) {
      await openPath(item.path);
      return;
    }

    if (editorDirty && editorItem?.path != item.path) {
      if (!await _confirmDiscardEditorChanges()) return;
    }

    setState(() {
      previewLoading = true;
      error = null;
      _currentOffset = offset;
      preview = RemoteFilePreviewData.binary(
        item: item,
        message: 'Preparing preview...',
      );
      if (editorItem?.path != item.path) {
        _clearEditorState();
      }
    });

    try {
      final provider = context.read<SSHProvider>();
      final kind = _previewKindFor(item.name);
      RemoteFilePreviewData next;

      if (kind == RemoteFilePreviewKind.image) {
        final bytes = await provider.readRemoteFileBytes(
          item.path,
          maxBytes: _maxImagePreviewBytes,
        );
        next = RemoteFilePreviewData.image(
          item: item,
          bytes: bytes,
          mimeType: _mimeTypeFor(item.name),
        );
      } else if (kind == RemoteFilePreviewKind.video) {
        final bytes = await provider.readRemoteFileBytes(
          item.path,
          maxBytes: _maxVideoPreviewBytes,
        );
        next = RemoteFilePreviewData.video(
          item: item,
          bytes: bytes,
          mimeType: _mimeTypeFor(item.name),
        );
      } else if (kind == RemoteFilePreviewKind.markdown) {
        final text = await provider.readRemoteFile(
          item.path,
          maxBytes: _maxTextPreviewBytes,
          offset: offset,
        );
        next = RemoteFilePreviewData.markdown(
          item: item,
          text: text,
          truncated: text.contains('[Preview truncated:'),
        );
      } else if (kind == RemoteFilePreviewKind.text) {
        final text = await provider.readRemoteFile(
          item.path,
          maxBytes: _maxTextPreviewBytes,
          offset: offset,
        );
        next = RemoteFilePreviewData.text(
          item: item,
          text: text,
          truncated: text.contains('[Preview truncated:'),
        );
      } else if (kind == RemoteFilePreviewKind.spreadsheet) {
        final ext = _extensionOf(item.name);
        if (ext == 'xlsx' || ext == 'xls') {
          final bytes = await provider.readRemoteFileBytes(
            item.path,
            maxBytes: _maxImagePreviewBytes,
          );
          next = RemoteFilePreviewData.spreadsheet(
            item: item,
            bytes: bytes,
          );
        } else {
          final text = await provider.readRemoteFile(
            item.path,
            maxBytes: _maxTextPreviewBytes,
            offset: offset,
          );
          final bytes = Uint8List.fromList(utf8.encode(text));
          next = RemoteFilePreviewData.spreadsheet(
            item: item,
            bytes: bytes,
            text: text,
            truncated: text.contains('[Preview truncated:'),
          );
        }
      } else if (kind == RemoteFilePreviewKind.pdf) {
        final bytes = await provider.readRemoteFileBytes(
          item.path,
          maxBytes: _maxImagePreviewBytes,
        );
        next = RemoteFilePreviewData.pdf(
          item: item,
          bytes: bytes,
        );
      } else {
        next = RemoteFilePreviewData.binary(
          item: item,
          message: 'This file type is not previewable inline. Use the action menu to copy its path.',
        );
      }

      if (!mounted) return;
      setState(() {
        preview = next;
        final isEditableKind = (next.kind == RemoteFilePreviewKind.text ||
            next.kind == RemoteFilePreviewKind.markdown ||
            next.kind == RemoteFilePreviewKind.spreadsheet);
        if (isEditableKind) {
          final ext = _extensionOf(item.name);
          final canEditExt = (ext == 'csv' || ext == 'tsv' || next.kind == RemoteFilePreviewKind.text || next.kind == RemoteFilePreviewKind.markdown);
          if (canEditExt && next.text != null) {
            _setEditorText(item, next.text!);
          } else {
            _clearEditorState();
          }
        } else {
          _clearEditorState();
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        preview = RemoteFilePreviewData.error(item: item, message: e.toString());
      });
    } finally {
      if (mounted) {
        setState(() {
          previewLoading = false;
        });
      }
    }
  }

  Future<void> _saveCurrentEditor() async {
    final item = editorItem;
    if (item == null || !_canEditCurrentPreview || editorSaving || !editorDirty) return;

    setState(() {
      editorSaving = true;
      error = null;
    });

    final messenger = ScaffoldMessenger.of(context);
    try {
      await context.read<SSHProvider>().writeRemoteFile(item.path, editorController.text);
      if (!mounted) return;
      setState(() {
        editorDirty = false;
        preview = preview.kind == RemoteFilePreviewKind.markdown
            ? RemoteFilePreviewData.markdown(
                item: item,
                text: editorController.text,
                truncated: false,
              )
            : RemoteFilePreviewData.text(
                item: item,
                text: editorController.text,
                truncated: false,
              );
      });
      messenger.showSnackBar(SnackBar(content: Text('Saved ${item.name}')));
      final current = listing?.path ?? pathController.text.trim();
      if (current.isNotEmpty) {
        final next = await context.read<SSHProvider>().listRemoteDirectory(current);
        if (mounted) {
          setState(() {
            listing = next;
            pathController.text = next.path;
          });
        }
      }
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Save failed: $e')));
    } finally {
      if (mounted) {
        setState(() {
          editorSaving = false;
        });
      }
    }
  }

  Future<void> _reloadCurrentEditor() async {
    final item = editorItem;
    if (item == null || editorSaving) return;
    if (editorDirty && !await _confirmDiscardEditorChanges()) return;
    await openFile(item);
  }

  String _parentOf(String path) {
    final clean = path.endsWith('/') && path.length > 1
        ? path.substring(0, path.length - 1)
        : path;
    if (clean == '/' || !clean.contains('/')) return '/';
    final index = clean.lastIndexOf('/');
    if (index <= 0) return '/';
    return clean.substring(0, index);
  }

  String _dirname(String path) {
    final index = path.lastIndexOf('/');
    if (index <= 0) return '/';
    return path.substring(0, index);
  }

  String _extensionOf(String name) {
    final index = name.lastIndexOf('.');
    if (index < 0 || index == name.length - 1) return '';
    return name.substring(index + 1).toLowerCase();
  }

  RemoteFilePreviewKind _previewKindFor(String name) {
    final ext = _extensionOf(name);

    const images = {
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'bmp',
      'wbmp',
    };

    const videos = {
      'mp4',
      'm4v',
      'mov',
      'webm',
      'mkv',
      'avi',
      '3gp',
    };

    const markdown = {
      'md',
      'markdown',
      'mdown',
      'mkd',
    };

    const spreadsheet = {
      'csv',
      'tsv',
      'xlsx',
      'xls',
    };

    const pdf = {
      'pdf',
    };

    const text = {
      'txt',
      'log',
      'json',
      'jsonl',
      'yaml',
      'yml',
      'toml',
      'xml',
      'html',
      'htm',
      'css',
      'ini',
      'conf',
      'cfg',
      'env',
      'sh',
      'bash',
      'zsh',
      'fish',
      'py',
      'dart',
      'js',
      'ts',
      'jsx',
      'tsx',
      'java',
      'kt',
      'swift',
      'c',
      'h',
      'cc',
      'cpp',
      'hpp',
      'go',
      'rs',
      'r',
      'sql',
      'ipynb',
      'dockerfile',
    };

    if (images.contains(ext)) return RemoteFilePreviewKind.image;
    if (videos.contains(ext)) return RemoteFilePreviewKind.video;
    if (markdown.contains(ext)) return RemoteFilePreviewKind.markdown;
    if (spreadsheet.contains(ext)) return RemoteFilePreviewKind.spreadsheet;
    if (pdf.contains(ext)) return RemoteFilePreviewKind.pdf;
    if (text.contains(ext) || name.toLowerCase() == 'dockerfile') {
      return RemoteFilePreviewKind.text;
    }
    return RemoteFilePreviewKind.binary;
  }

  String _mimeTypeFor(String name) {
    switch (_extensionOf(name)) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'bmp':
        return 'image/bmp';
      case 'mp4':
      case 'm4v':
        return 'video/mp4';
      case 'mov':
        return 'video/quicktime';
      case 'webm':
        return 'video/webm';
      case 'mkv':
        return 'video/x-matroska';
      case 'avi':
        return 'video/x-msvideo';
      case '3gp':
        return 'video/3gpp';
      case 'md':
      case 'markdown':
        return 'text/markdown';
      case 'json':
        return 'application/json';
      case 'html':
      case 'htm':
        return 'text/html';
      case 'xml':
        return 'application/xml';
      default:
        return 'application/octet-stream';
    }
  }

  IconData _iconFor(RemoteFileItem item) {
    if (item.isDirectory) return Icons.folder_outlined;
    if (item.isSymlink) return Icons.link_outlined;

    switch (_previewKindFor(item.name)) {
      case RemoteFilePreviewKind.image:
        return Icons.image_outlined;
      case RemoteFilePreviewKind.video:
        return Icons.movie_outlined;
      case RemoteFilePreviewKind.markdown:
        return Icons.article_outlined;
      case RemoteFilePreviewKind.text:
        return Icons.description_outlined;
      case RemoteFilePreviewKind.spreadsheet:
        return Icons.table_chart_outlined;
      case RemoteFilePreviewKind.pdf:
        return Icons.picture_as_pdf_outlined;
      case RemoteFilePreviewKind.binary:
        return Icons.insert_drive_file_outlined;
      case RemoteFilePreviewKind.none:
      case RemoteFilePreviewKind.error:
        return Icons.insert_drive_file_outlined;
    }
  }

  String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    final kb = bytes / 1024;
    if (kb < 1024) return '${kb.toStringAsFixed(1)} KB';
    final mb = kb / 1024;
    if (mb < 1024) return '${mb.toStringAsFixed(1)} MB';
    final gb = mb / 1024;
    return '${gb.toStringAsFixed(1)} GB';
  }

  void _stageFileOperation(RemoteFileItem item, _RemoteClipboardMode mode) {
    setState(() {
      remoteClipboard = _RemoteClipboardEntry(item: item, mode: mode);
    });
    final action = mode == _RemoteClipboardMode.copy ? 'Copy' : 'Move';
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$action staged: ${item.name}. Open a target folder and press Paste.')),
    );
  }

  Future<void> _pasteStagedItem() async {
    final staged = remoteClipboard;
    final targetDirectory = listing?.path ?? pathController.text.trim();
    if (staged == null || targetDirectory.isEmpty || fileOperationRunning) return;

    setState(() {
      fileOperationRunning = true;
      error = null;
    });

    final messenger = ScaffoldMessenger.of(context);
    final provider = context.read<SSHProvider>();

    try {
      final String resultPath;
      if (staged.mode == _RemoteClipboardMode.copy) {
        resultPath = await provider.copyRemotePathToDirectory(staged.item.path, targetDirectory);
        messenger.showSnackBar(SnackBar(content: Text('Copied to $resultPath')));
      } else {
        resultPath = await provider.moveRemotePathToDirectory(staged.item.path, targetDirectory);
        if (mounted) {
          setState(() {
            remoteClipboard = null;
            if (preview.item?.path == staged.item.path) {
              preview = const RemoteFilePreviewData.empty();
              _clearEditorState();
            }
          });
        }
        messenger.showSnackBar(SnackBar(content: Text('Moved to $resultPath')));
      }
      await openPath(targetDirectory, confirmDiscard: false, clearPreview: false);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Paste failed: $e')));
    } finally {
      if (mounted) {
        setState(() {
          fileOperationRunning = false;
        });
      }
    }
  }

  Future<void> _deleteItem(RemoteFileItem item) async {
    final current = listing?.path ?? '~';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: Text('Delete ${item.isDirectory ? 'folder' : 'file'}?'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(item.name, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              SelectableText(item.path),
              const SizedBox(height: 12),
              const Text('This uses rm -rf on the remote host and cannot be undone.'),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton.tonalIcon(
              onPressed: () => Navigator.pop(context, true),
              icon: const Icon(Icons.delete_forever),
              label: const Text('Delete'),
            ),
          ],
        );
      },
    );

    if (confirmed != true || !mounted || fileOperationRunning) return;

    setState(() {
      fileOperationRunning = true;
      error = null;
    });

    final messenger = ScaffoldMessenger.of(context);
    final provider = context.read<SSHProvider>();

    try {
      await provider.deleteRemotePath(item.path);
      if (!mounted) return;
      setState(() {
        if (preview.item?.path == item.path) {
          preview = const RemoteFilePreviewData.empty();
          _clearEditorState();
        }
        if (remoteClipboard?.item.path == item.path) {
          remoteClipboard = null;
        }
      });
      messenger.showSnackBar(SnackBar(content: Text('Deleted ${item.name}')));
      await openPath(current, confirmDiscard: false, clearPreview: false);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Delete failed: $e')));
    } finally {
      if (mounted) {
        setState(() {
          fileOperationRunning = false;
        });
      }
    }
  }

  Widget _buildClipboardBar(String currentPath) {
    final staged = remoteClipboard;
    if (staged == null) return const SizedBox.shrink();
    final isWide = MediaQuery.of(context).size.width >= 760;

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: AppPalette.surfaceElevated,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppPalette.border),
      ),
      child: Row(
        children: [
          Icon(staged.icon, size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '${staged.actionLabel}: ${staged.item.name}  →  $currentPath',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 8),
          if (isWide)
            FilledButton.tonalIcon(
              onPressed: fileOperationRunning || directoryLoading ? null : _pasteStagedItem,
              icon: fileOperationRunning
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.content_paste_outlined),
              label: Text(staged.pasteLabel),
            )
          else
            IconButton(
              visualDensity: VisualDensity.compact,
              tooltip: staged.pasteLabel,
              onPressed: fileOperationRunning || directoryLoading ? null : _pasteStagedItem,
              icon: fileOperationRunning
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.content_paste_outlined),
            ),
          IconButton(
            tooltip: 'Cancel',
            onPressed: fileOperationRunning ? null : () => setState(() => remoteClipboard = null),
            icon: const Icon(Icons.close_outlined),
          ),
        ],
      ),
    );
  }

  Future<void> _showItemActions(RemoteFileItem item) async {
    final current = listing?.path ?? '~';
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (context) {
        return SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: [
              ListTile(
                title: Text(item.name),
                subtitle: Text(item.path),
              ),
              const Divider(height: 1),
              ListTile(
                leading: Icon(item.isDirectory ? Icons.folder_open_outlined : Icons.visibility_outlined),
                title: Text(item.isDirectory ? 'Open folder' : 'Open / edit file'),
                onTap: () => Navigator.pop(context, 'open'),
              ),
              ListTile(
                leading: const Icon(Icons.drive_file_rename_outline),
                title: const Text('Rename'),
                onTap: () => Navigator.pop(context, 'rename'),
              ),
              ListTile(
                leading: const Icon(Icons.content_copy_outlined),
                title: const Text('Copy'),
                subtitle: const Text('Stage this item, then paste it into another folder'),
                onTap: () => Navigator.pop(context, 'stageCopy'),
              ),
              ListTile(
                leading: const Icon(Icons.drive_file_move_outlined),
                title: const Text('Move'),
                subtitle: const Text('Stage this item, then paste it into another folder'),
                onTap: () => Navigator.pop(context, 'stageMove'),
              ),
              ListTile(
                leading: const Icon(Icons.copy_all_outlined),
                title: const Text('Duplicate here'),
                subtitle: const Text('Create a copy in the same folder'),
                onTap: () => Navigator.pop(context, 'duplicate'),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.content_copy_outlined),
                title: const Text('Copy name'),
                onTap: () => Navigator.pop(context, 'copyName'),
              ),
              ListTile(
                leading: const Icon(Icons.copy_all_outlined),
                title: const Text('Copy abs path'),
                onTap: () => Navigator.pop(context, 'copyAbs'),
              ),
              ListTile(
                leading: const Icon(Icons.notes_outlined),
                title: const Text('Copy rel path'),
                onTap: () => Navigator.pop(context, 'copyRel'),
              ),
              ListTile(
                leading: const Icon(Icons.my_location_outlined),
                title: const Text('Set PWD'),
                subtitle: const Text('Use this folder for new Commands / Agents pages'),
                onTap: () => Navigator.pop(context, 'setPwd'),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.delete_outline, color: Colors.redAccent),
                title: const Text('Delete', style: TextStyle(color: Colors.redAccent)),
                subtitle: const Text('Remove this item from the remote host'),
                onTap: () => Navigator.pop(context, 'delete'),
              ),
            ],
          ),
        );
      },
    );

    if (!mounted || action == null) return;

    final messenger = ScaffoldMessenger.of(context);
    final provider = context.read<SSHProvider>();

    try {
      if (action == 'rename') {
        final newName = await showDialog<String>(
          context: context,
          builder: (_) => _RenameDialog(initialName: item.name),
        );
        if (newName != null && newName.trim().isNotEmpty) {
          await provider.renameRemotePath(item.path, newName.trim());
          if (preview.item?.path == item.path) {
            setState(() {
              preview = const RemoteFilePreviewData.empty();
              _clearEditorState();
            });
          }
          await openPath(current, confirmDiscard: false, clearPreview: false);
        }
      } else if (action == 'copyName') {
        await Clipboard.setData(ClipboardData(text: item.name));
        messenger.showSnackBar(const SnackBar(content: Text('Copied name')));
      } else if (action == 'copyAbs') {
        await Clipboard.setData(ClipboardData(text: item.path));
        messenger.showSnackBar(const SnackBar(content: Text('Copied absolute path')));
      } else if (action == 'copyRel') {
        await Clipboard.setData(ClipboardData(text: item.name));
        messenger.showSnackBar(const SnackBar(content: Text('Copied relative path')));
      } else if (action == 'duplicate') {
        final copied = await provider.duplicateRemotePath(item.path);
        messenger.showSnackBar(SnackBar(content: Text('Copied to $copied')));
        await openPath(current, confirmDiscard: false, clearPreview: false);
      } else if (action == 'stageCopy') {
        _stageFileOperation(item, _RemoteClipboardMode.copy);
      } else if (action == 'stageMove') {
        _stageFileOperation(item, _RemoteClipboardMode.move);
      } else if (action == 'delete') {
        await _deleteItem(item);
      } else if (action == 'open') {
        if (item.isDirectory) {
          await openPath(item.path);
        } else {
          await openFile(item);
        }
      } else if (action == 'setPwd') {
        final pwd = item.isDirectory ? item.path : _dirname(item.path);
        provider.setSharedPwd(pwd);
        messenger.showSnackBar(SnackBar(content: Text('PWD set to $pwd')));
      }
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Action failed: $e')));
    }
  }

  String _quoteArg(String input) {
    return "'${input.replaceAll("'", "'\"'\"'")}'";
  }

  Future<void> _createNewFile() async {
    final currentDir = listing?.path ?? pathController.text.trim();
    if (currentDir.isEmpty || fileOperationRunning) return;

    final name = await showDialog<String>(
      context: context,
      builder: (_) => const _CreateItemDialog(isFolder: false),
    );

    if (name == null || name.trim().isEmpty) return;

    setState(() {
      fileOperationRunning = true;
      error = null;
    });

    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final provider = context.read<SSHProvider>();
    final trimmedName = name.trim();
    final fullPath = currentDir == '/' ? '/$trimmedName' : '$currentDir/$trimmedName';

    try {
      final quotedPath = _quoteArg(fullPath);
      final command = '''
target=$quotedPath
case "\$target" in
  '~') target="\$HOME" ;;
  '~/'*) target="\$HOME/\${target#~/}" ;;
esac
touch "\$target"
''';
      await provider.runRemoteShell(command);
      messenger.showSnackBar(SnackBar(content: Text('Created file: $trimmedName')));
      await openPath(currentDir, confirmDiscard: false, clearPreview: false);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Create file failed: $e')));
    } finally {
      if (mounted) {
        setState(() {
          fileOperationRunning = false;
        });
      }
    }
  }

  Future<void> _createNewFolder() async {
    final currentDir = listing?.path ?? pathController.text.trim();
    if (currentDir.isEmpty || fileOperationRunning) return;

    final name = await showDialog<String>(
      context: context,
      builder: (_) => const _CreateItemDialog(isFolder: true),
    );

    if (name == null || name.trim().isEmpty) return;

    setState(() {
      fileOperationRunning = true;
      error = null;
    });

    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final provider = context.read<SSHProvider>();
    final trimmedName = name.trim();
    final fullPath = currentDir == '/' ? '/$trimmedName' : '$currentDir/$trimmedName';

    try {
      final quotedPath = _quoteArg(fullPath);
      final command = '''
target=$quotedPath
case "\$target" in
  '~') target="\$HOME" ;;
  '~/'*) target="\$HOME/\${target#~/}" ;;
esac
mkdir -p "\$target"
''';
      await provider.runRemoteShell(command);
      messenger.showSnackBar(SnackBar(content: Text('Created folder: $trimmedName')));
      await openPath(currentDir, confirmDiscard: false, clearPreview: false);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Create folder failed: $e')));
    } finally {
      if (mounted) {
        setState(() {
          fileOperationRunning = false;
        });
      }
    }
  }

  Future<void> _showPreviewDialog(RemoteFilePreviewData data) async {
    if (data.item == null) return;
    await showDialog<void>(
      context: context,
      builder: (_) {
        return Dialog.fullscreen(
          child: Scaffold(
            appBar: AppBar(
              title: Text(data.item!.name, overflow: TextOverflow.ellipsis),
              actions: [
                IconButton(
                  tooltip: 'Copy path',
                  onPressed: () => Clipboard.setData(ClipboardData(text: data.item!.path)),
                  icon: const Icon(Icons.copy_all),
                ),
              ],
            ),
            body: _FilePreviewPane(
              data: data,
              loading: false,
              onOpenFullscreen: null,
              showEditor: false,
              canToggleEditor: false,
              showFindBar: false,
              currentMatchIndex: -1,
              totalMatches: 0,
              showReplace: false,
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final currentPath = listing?.path ?? pathController.text.trim();
    final items = listing?.items ?? const <RemoteFileItem>[];
    final isWide = MediaQuery.of(context).size.width >= 760;

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyP, control: true, shift: true): () {
          _showCommandPaletteDialog();
        },
        const SingleActivator(LogicalKeyboardKey.f1): () {
          _showCommandPaletteDialog();
        },
      },
      child: FocusScope(
        autofocus: true,
        child: Column(
      children: [
        Container(
          decoration: BoxDecoration(
            color: AppPalette.surface,
            border: Border(bottom: BorderSide(color: AppPalette.border, width: 1)),
          ),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  IconButton(
                    visualDensity: isWide ? null : VisualDensity.compact,
                    tooltip: 'Parent folder',
                    onPressed: directoryLoading ? null : () => openPath(_parentOf(currentPath)),
                    icon: const Icon(Icons.arrow_upward_outlined),
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: TextField(
                      controller: pathController,
                      style: const TextStyle(fontSize: 13),
                      decoration: InputDecoration(
                        labelText: 'Remote path',
                        prefixIcon: Icon(Icons.folder_outlined, size: 14, color: AppPalette.accent),
                        border: const OutlineInputBorder(),
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      ),
                      onSubmitted: openPath,
                    ),
                  ),
                  const SizedBox(width: 6),
                  if (isWide)
                    FilledButton.tonalIcon(
                      onPressed: directoryLoading ? null : () => openPath(pathController.text),
                      icon: const Icon(Icons.folder_open_outlined),
                      label: const Text('Open'),
                    )
                  else
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Open folder',
                      onPressed: directoryLoading ? null : () => openPath(pathController.text),
                      icon: const Icon(Icons.folder_open_outlined),
                    ),
                  const SizedBox(width: 4),
                  IconButton(
                    visualDensity: isWide ? null : VisualDensity.compact,
                    tooltip: 'New File',
                    icon: const Icon(Icons.note_add_outlined),
                    onPressed: directoryLoading ? null : _createNewFile,
                  ),
                  IconButton(
                    visualDensity: isWide ? null : VisualDensity.compact,
                    tooltip: 'New Folder',
                    icon: const Icon(Icons.create_new_folder_outlined),
                    onPressed: directoryLoading ? null : _createNewFolder,
                  ),
                ],
              ),
              const SizedBox(height: 10),
              _buildBreadcrumbsRow(currentPath),
              _buildClipboardBar(currentPath),
            ],
          ),
        ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.all(8),
            child: ErrorCard(message: error!),
          ),
        Expanded(
          child: (!isWide && preview.item != null)
              ? _FilePreviewPane(
                  data: preview,
                  loading: previewLoading,
                  onOpenFullscreen: () => _showPreviewDialog(preview),
                  onClose: () => setState(() {
                    preview = RemoteFilePreviewData.empty();
                  }),
                  editorController: editorController,
                  canEdit: _canEditCurrentPreview,
                  editorDirty: editorDirty,
                  editorSaving: editorSaving,
                  onSave: _saveCurrentEditor,
                  onReload: _reloadCurrentEditor,
                  showEditor: _showEditorInsteadOfPreview,
                  canToggleEditor: _canEditCurrentPreview && (preview.kind == RemoteFilePreviewKind.markdown || preview.kind == RemoteFilePreviewKind.spreadsheet),
                  onToggleEditor: () => setState(() {
                    _showEditorInsteadOfPreview = !_showEditorInsteadOfPreview;
                  }),
                  showFindBar: _showFindBar,
                  onToggleFindBar: () => setState(() {
                    _showFindBar = !_showFindBar;
                    if (!_showFindBar) {
                      _findController.clear();
                    }
                  }),
                  findController: _findController,
                  onFindNext: _findNext,
                  onFindPrev: _findPrev,
                  currentMatchIndex: _currentMatchIndex,
                  totalMatches: _findMatchOffsets.length,
                  editorScrollController: _editorScrollController,
                  lineScrollController: _lineScrollController,
                  replaceController: _replaceController,
                  onReplace: _performReplace,
                  onReplaceAll: _performReplaceAll,
                  showReplace: _showReplace,
                  onToggleReplace: () => setState(() {
                    _showReplace = !_showReplace;
                  }),
                  onGoToLine: () => _showGoToLineDialog(context),
                  currentOffset: _currentOffset,
                  onPageChanged: (offset) => openFile(preview.item!, offset: offset),
                  onSpreadsheetChanged: (newText) {
                    _suppressEditorDirty = true;
                    editorController.text = newText;
                    _suppressEditorDirty = false;
                    setState(() {
                      editorDirty = true;
                    });
                  },
                )
              : Row(
                  children: [
                    Expanded(
                      flex: 2,
                      child: Stack(
                        children: [
                          listing == null && directoryLoading
                              ? const Center(child: CircularProgressIndicator())
                              : listing == null && !initialized
                                  ? const Center(child: Text('Opening folder...'))
                                  : items.isEmpty && !directoryLoading
                                      ? const Center(child: Text('No files'))
                                      : ListView.builder(
                                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                                          itemCount: items.length,
                                          itemBuilder: (context, index) {
                                            final item = items[index];
                                            final selected = preview.item?.path == item.path;
                                            final iconData = _iconFor(item);
                                            
                                            // Premium color-coded icons
                                            Color iconColor;
                                            if (item.isDirectory) {
                                              iconColor = AppPalette.accent; // Blue folders
                                            } else if (item.isSymlink) {
                                              iconColor = AppPalette.warning; // Yellow links
                                            } else {
                                              final previewKind = _previewKindFor(item.name);
                                              switch (previewKind) {
                                                case RemoteFilePreviewKind.image:
                                                  iconColor = const Color(0xFF4EC9B0); // Teal images
                                                  break;
                                                case RemoteFilePreviewKind.video:
                                                  iconColor = const Color(0xFFCE9178); // Coral videos
                                                  break;
                                                case RemoteFilePreviewKind.markdown:
                                                  iconColor = const Color(0xFF9CDCFE); // Light blue md
                                                  break;
                                                case RemoteFilePreviewKind.text:
                                                  iconColor = const Color(0xFFDCDCAA); // Pale yellow text
                                                  break;
                                                default:
                                                  iconColor = AppPalette.textSecondary; // Grey binaries/other
                                              }
                                            }

                                            return Padding(
                                              padding: const EdgeInsets.symmetric(vertical: 2),
                                              child: Material(
                                                color: selected ? AppPalette.surfaceSoft : Colors.transparent,
                                                borderRadius: BorderRadius.circular(6),
                                                child: InkWell(
                                                  borderRadius: BorderRadius.circular(6),
                                                  onTap: () => item.isDirectory ? openPath(item.path) : openFile(item),
                                                  onLongPress: () => _showItemActions(item),
                                                  child: Container(
                                                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                                                    decoration: BoxDecoration(
                                                      border: Border(
                                                        left: BorderSide(
                                                          color: selected ? AppPalette.accent : Colors.transparent,
                                                          width: 3,
                                                        ),
                                                      ),
                                                    ),
                                                    child: Row(
                                                      children: [
                                                        Icon(
                                                          iconData,
                                                          size: 18,
                                                          color: iconColor,
                                                        ),
                                                        const SizedBox(width: 10),
                                                        Expanded(
                                                          child: Column(
                                                            crossAxisAlignment: CrossAxisAlignment.start,
                                                            children: [
                                                              Text(
                                                                item.name,
                                                                style: TextStyle(
                                                                  color: selected ? AppPalette.textPrimary : AppPalette.textSecondary,
                                                                  fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
                                                                  fontSize: 13.5,
                                                                ),
                                                                maxLines: 1,
                                                                overflow: TextOverflow.ellipsis,
                                                              ),
                                                              const SizedBox(height: 2),
                                                              Text(
                                                                '${item.displayType} · ${item.isDirectory ? '-' : _formatSize(item.sizeBytes)} · ${item.modified}',
                                                                style: TextStyle(
                                                                  color: AppPalette.textMuted,
                                                                  fontSize: 11,
                                                                ),
                                                                maxLines: 1,
                                                                overflow: TextOverflow.ellipsis,
                                                              ),
                                                            ],
                                                          ),
                                                        ),
                                                        const SizedBox(width: 8),
                                                        Row(
                                                          mainAxisSize: MainAxisSize.min,
                                                          children: [
                                                            if (!item.isDirectory)
                                                              IconButton(
                                                                visualDensity: VisualDensity.compact,
                                                                iconSize: 16,
                                                                tooltip: 'Open / edit',
                                                                icon: const Icon(Icons.visibility_outlined),
                                                                onPressed: () => openFile(item),
                                                              ),
                                                            IconButton(
                                                              visualDensity: VisualDensity.compact,
                                                              iconSize: 16,
                                                              tooltip: 'Actions',
                                                              icon: const Icon(Icons.more_vert_outlined),
                                                              onPressed: () => _showItemActions(item),
                                                            ),
                                                          ],
                                                        ),
                                                      ],
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            );
                                          },
                                        ),
                          if (directoryLoading && listing != null)
                            Positioned.fill(
                              child: IgnorePointer(
                                child: DecoratedBox(
                                  decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.08)),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                    if (isWide) VerticalDivider(width: 1, color: AppPalette.border),
                    if (isWide)
                      Expanded(
                        flex: 3,
                        child: _FilePreviewPane(
                          data: preview,
                          loading: previewLoading,
                          onOpenFullscreen: preview.item == null ? null : () => _showPreviewDialog(preview),
                          editorController: editorController,
                          canEdit: _canEditCurrentPreview,
                          editorDirty: editorDirty,
                          editorSaving: editorSaving,
                          onSave: _saveCurrentEditor,
                          onReload: _reloadCurrentEditor,
                          showEditor: _showEditorInsteadOfPreview,
                          canToggleEditor: _canEditCurrentPreview && (preview.kind == RemoteFilePreviewKind.markdown || preview.kind == RemoteFilePreviewKind.spreadsheet),
                          onToggleEditor: () => setState(() {
                            _showEditorInsteadOfPreview = !_showEditorInsteadOfPreview;
                          }),
                          showFindBar: _showFindBar,
                          onToggleFindBar: () => setState(() {
                            _showFindBar = !_showFindBar;
                            if (!_showFindBar) {
                              _findController.clear();
                            }
                          }),
                          findController: _findController,
                          onFindNext: _findNext,
                          onFindPrev: _findPrev,
                          currentMatchIndex: _currentMatchIndex,
                          totalMatches: _findMatchOffsets.length,
                          editorScrollController: _editorScrollController,
                          lineScrollController: _lineScrollController,
                          replaceController: _replaceController,
                          onReplace: _performReplace,
                          onReplaceAll: _performReplaceAll,
                          showReplace: _showReplace,
                          onToggleReplace: () => setState(() {
                            _showReplace = !_showReplace;
                          }),
                          onGoToLine: () => _showGoToLineDialog(context),
                          currentOffset: _currentOffset,
                          onPageChanged: (offset) => openFile(preview.item!, offset: offset),
                          onSpreadsheetChanged: (newText) {
                            _suppressEditorDirty = true;
                            editorController.text = newText;
                            _suppressEditorDirty = false;
                            setState(() {
                              editorDirty = true;
                            });
                          },
                        ),
                      ),
                  ],
                ),
        ),
      ],
        ),
      ),
    );
  }

  Widget _buildBreadcrumbsRow(String path) {
    final clean = path.trim().isEmpty ? '/' : path.trim();
    final parts = clean.split('/').where((e) => e.isNotEmpty).toList();
    
    final widgets = <Widget>[];
    
    // Add root or home
    final isHome = clean.startsWith('~');
    final rootLabel = isHome ? '~' : '/';
    final rootPath = isHome ? '~' : '/';
    
    widgets.add(
      InkWell(
        borderRadius: BorderRadius.circular(4),
        onTap: () => openPath(rootPath),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
          child: Text(
            rootLabel,
            style: TextStyle(
              color: AppPalette.textSecondary,
              fontWeight: FontWeight.w500,
              fontSize: 13,
            ),
          ),
        ),
      ),
    );

    var current = isHome ? '~' : '';
    for (final part in parts) {
      if (current == '~') {
        current = '~/';
      }
      if (current.endsWith('/')) {
        current += part;
      } else {
        current += '/$part';
      }
      final target = current;
      
      widgets.add(
        Icon(
          Icons.chevron_right,
          size: 14,
          color: AppPalette.textMuted,
        ),
      );
      
      widgets.add(
        InkWell(
          borderRadius: BorderRadius.circular(4),
          onTap: () => openPath(target),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            child: Text(
              part,
              style: TextStyle(
                color: AppPalette.textSecondary,
                fontWeight: FontWeight.w500,
                fontSize: 13,
              ),
            ),
          ),
        ),
      );
    }

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
                                        mainAxisSize: MainAxisSize.min,
        children: widgets,
      ),
    );
  }
}

class _FilePreviewPane extends StatelessWidget {
  final RemoteFilePreviewData data;
  final bool loading;
  final VoidCallback? onOpenFullscreen;
  final TextEditingController? editorController;
  final bool canEdit;
  final bool editorDirty;
  final bool editorSaving;
  final VoidCallback? onSave;
  final VoidCallback? onReload;
  final bool showEditor;
  final bool canToggleEditor;
  final VoidCallback? onToggleEditor;
  final bool showFindBar;
  final VoidCallback? onToggleFindBar;
  final TextEditingController? findController;
  final VoidCallback? onFindNext;
  final VoidCallback? onFindPrev;
  final int currentMatchIndex;
  final int totalMatches;
  final ScrollController? editorScrollController;
  final ScrollController? lineScrollController;
  final TextEditingController? replaceController;
  final VoidCallback? onReplace;
  final VoidCallback? onReplaceAll;
  final bool showReplace;
  final VoidCallback? onToggleReplace;
  final VoidCallback? onGoToLine;
  final int currentOffset;
  final ValueChanged<int>? onPageChanged;
  final ValueChanged<String>? onSpreadsheetChanged;
  final VoidCallback? onClose;

  const _FilePreviewPane({
    required this.data,
    required this.loading,
    required this.onOpenFullscreen,
    this.editorController,
    this.canEdit = false,
    this.editorDirty = false,
    this.editorSaving = false,
    this.onSave,
    this.onReload,
    required this.showEditor,
    required this.canToggleEditor,
    this.onToggleEditor,
    required this.showFindBar,
    this.onToggleFindBar,
    this.findController,
    this.onFindNext,
    this.onFindPrev,
    required this.currentMatchIndex,
    required this.totalMatches,
    this.editorScrollController,
    this.lineScrollController,
    this.replaceController,
    this.onReplace,
    this.onReplaceAll,
    required this.showReplace,
    this.onToggleReplace,
    this.onGoToLine,
    this.currentOffset = 0,
    this.onPageChanged,
    this.onSpreadsheetChanged,
    this.onClose,
  });

  @override
  Widget build(BuildContext context) {
    final item = data.item;
    final effectiveShowEditor = (data.kind == RemoteFilePreviewKind.text) || showEditor;
    final titlePrefix = effectiveShowEditor ? 'Editor' : 'Preview';
    return Container(
      color: AppPalette.backgroundDeep,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            color: AppPalette.surface,
            child: Row(
              children: [
                if (onClose != null)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: IconButton(
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Back to file list',
                      onPressed: onClose,
                      icon: const Icon(Icons.arrow_back, size: 18),
                    ),
                  ),
                Expanded(
                  child: Text(
                    item == null ? 'Preview' : '$titlePrefix: ${item.name}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                if (canEdit && effectiveShowEditor && onToggleFindBar != null)
                  IconButton(
                    tooltip: 'Find (Ctrl+F)',
                    onPressed: onToggleFindBar,
                    icon: Icon(showFindBar ? Icons.search_off : Icons.search, size: 18),
                  ),
                if (canToggleEditor && onToggleEditor != null)
                  IconButton(
                    tooltip: effectiveShowEditor ? 'Show Preview' : 'Show Editor',
                    onPressed: onToggleEditor,
                    icon: Icon(effectiveShowEditor ? Icons.visibility_outlined : Icons.edit_outlined, size: 18),
                  ),
                if (canEdit && effectiveShowEditor)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: Tooltip(
                      message: editorDirty ? 'Unsaved changes' : 'Saved',
                      child: Icon(
                        editorDirty ? Icons.circle : Icons.check_circle_outline,
                        size: 14,
                        color: editorDirty ? Colors.amber.shade300 : Colors.greenAccent.shade100,
                      ),
                    ),
                  ),
                if (canEdit && effectiveShowEditor)
                  IconButton(
                    tooltip: 'Reload from remote',
                    onPressed: editorSaving ? null : onReload,
                    icon: const Icon(Icons.refresh, size: 18),
                  ),
                if (canEdit && effectiveShowEditor)
                  FilledButton.tonalIcon(
                    onPressed: editorSaving || !editorDirty ? null : onSave,
                    icon: editorSaving
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.save, size: 18),
                    label: const Text('Save'),
                  ),
                if (item != null && data.truncated)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: Tooltip(
                      message: 'Preview is truncated',
                      child: Icon(Icons.content_cut, size: 18, color: Colors.amber.shade300),
                    ),
                  ),
                if (onOpenFullscreen != null)
                  IconButton(
                    tooltip: 'Fullscreen preview',
                    onPressed: onOpenFullscreen,
                    icon: const Icon(Icons.open_in_full, size: 18),
                  ),
              ],
            ),
          ),
          if (item != null && item.sizeBytes > 2 * 1024 * 1024 && (data.kind == RemoteFilePreviewKind.text || data.kind == RemoteFilePreviewKind.markdown || data.kind == RemoteFilePreviewKind.spreadsheet))
            _buildPager(context, item),
          Expanded(
            child: Stack(
              children: [
                Positioned.fill(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 180),
                    child: loading
                        ? const Center(key: ValueKey('preview-loading'), child: CircularProgressIndicator())
                        : _buildPreviewBody(context),
                  ),
                ),
                if (showFindBar && findController != null)
                  Positioned(
                    top: 8,
                    right: 8,
                    child: _buildFindPanel(context),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildFindPanel(BuildContext context) {
    final hasMatches = totalMatches > 0;
    final matchText = hasMatches
        ? '${currentMatchIndex + 1} of $totalMatches'
        : 'No results';

    return Container(
      width: 320,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: AppPalette.surfaceElevated,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: AppPalette.border),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.3),
            blurRadius: 8,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              IconButton(
                icon: Icon(showReplace ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_right, size: 16),
                onPressed: onToggleReplace,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
                tooltip: 'Toggle Replace',
              ),
              const SizedBox(width: 4),
              Expanded(
                child: SizedBox(
                  height: 28,
                  child: Focus(
                    onKeyEvent: (node, event) {
                      if (event.logicalKey == LogicalKeyboardKey.escape && event is KeyDownEvent) {
                        onToggleFindBar?.call();
                        return KeyEventResult.handled;
                      }
                      return KeyEventResult.ignored;
                    },
                    child: TextField(
                      controller: findController,
                      autofocus: true,
                      style: const TextStyle(fontSize: 12),
                      decoration: const InputDecoration(
                        hintText: 'Find',
                        contentPadding: EdgeInsets.symmetric(horizontal: 6, vertical: 0),
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                matchText,
                style: TextStyle(
                  fontSize: 11,
                  color: hasMatches ? AppPalette.textSecondary : AppPalette.textMuted,
                ),
              ),
              const SizedBox(width: 4),
              IconButton(
                icon: const Icon(Icons.arrow_upward, size: 14),
                onPressed: onFindPrev,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
                tooltip: 'Previous match',
              ),
              const SizedBox(width: 4),
              IconButton(
                icon: const Icon(Icons.arrow_downward, size: 14),
                onPressed: onFindNext,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
                tooltip: 'Next match',
              ),
              const SizedBox(width: 4),
              IconButton(
                icon: const Icon(Icons.close, size: 14),
                onPressed: onToggleFindBar,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
                tooltip: 'Close (Esc)',
              ),
            ],
          ),
          if (showReplace && replaceController != null) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                const SizedBox(width: 20),
                Expanded(
                  child: SizedBox(
                    height: 28,
                    child: TextField(
                      controller: replaceController,
                      style: const TextStyle(fontSize: 12),
                      decoration: const InputDecoration(
                        hintText: 'Replace',
                        contentPadding: EdgeInsets.symmetric(horizontal: 6, vertical: 0),
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  icon: const Icon(Icons.find_replace, size: 16),
                  onPressed: onReplace,
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  constraints: const BoxConstraints(),
                  tooltip: 'Replace',
                ),
                IconButton(
                  icon: const Icon(Icons.swap_horiz, size: 18),
                  onPressed: onReplaceAll,
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  constraints: const BoxConstraints(),
                  tooltip: 'Replace All',
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildPreviewBody(BuildContext context) {
    final effectiveShowEditor = (data.kind == RemoteFilePreviewKind.text) || showEditor;
    switch (data.kind) {
      case RemoteFilePreviewKind.none:
        return const Center(
          key: ValueKey('preview-empty'),
          child: Text('Select a file to preview'),
        );
      case RemoteFilePreviewKind.image:
        final bytes = data.bytes;
        if (bytes == null || bytes.isEmpty) {
          return const Center(child: Text('Image is empty or unreadable'));
        }
        return InteractiveViewer(
          key: ValueKey('image-${data.item?.path}'),
          minScale: 0.5,
          maxScale: 6,
          child: Center(
            child: Image.memory(
              bytes,
              fit: BoxFit.contain,
              gaplessPlayback: true,
            ),
          ),
        );
      case RemoteFilePreviewKind.video:
        final bytes = data.bytes;
        if (bytes == null || bytes.isEmpty) {
          return const Center(child: Text('Video is empty or unreadable'));
        }
        return _VideoPreview(
          key: ValueKey('video-${data.item?.path}-${bytes.length}'),
          bytes: bytes,
          mimeType: data.mimeType ?? 'video/mp4',
        );
      case RemoteFilePreviewKind.markdown:
        if (effectiveShowEditor) return _buildTextEditor(context);
        return SelectionArea(
          child: SingleChildScrollView(
            key: ValueKey('markdown-${data.item?.path}'),
            padding: const EdgeInsets.all(16),
            child: MarkdownBody(
              data: data.text?.isEmpty ?? true ? '[Empty file]' : data.text!,
              selectable: false,
              styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
                p: TextStyle(color: AppPalette.textSecondary, fontSize: 13, height: 1.5),
                h1: TextStyle(color: AppPalette.textPrimary, fontSize: 22, fontWeight: FontWeight.bold, height: 1.4),
                h2: TextStyle(color: AppPalette.textPrimary, fontSize: 18, fontWeight: FontWeight.bold, height: 1.4),
                h3: TextStyle(color: AppPalette.textPrimary, fontSize: 15, fontWeight: FontWeight.bold, height: 1.4),
                code: const TextStyle(fontFamily: 'monospace', fontSize: 12, backgroundColor: Colors.transparent),
                codeblockDecoration: BoxDecoration(
                  color: AppPalette.surfaceSoft,
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: AppPalette.border),
                ),
                blockquoteDecoration: BoxDecoration(
                  color: AppPalette.surfaceSoft,
                  border: Border(left: BorderSide(color: AppPalette.accent, width: 4)),
                ),
              ),
            ),
          ),
        );
      case RemoteFilePreviewKind.text:
        if (effectiveShowEditor) return _buildTextEditor(context);
        return SingleChildScrollView(
          key: ValueKey('text-${data.item?.path}'),
          padding: const EdgeInsets.all(12),
          child: SelectableText(
            data.text?.isEmpty ?? true ? '[Empty file]' : data.text!,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.35),
          ),
        );
      case RemoteFilePreviewKind.spreadsheet:
        if (effectiveShowEditor) return _buildTextEditor(context);
        return _SpreadsheetPreview(
          key: ValueKey('spreadsheet-${data.item?.path}'),
          bytes: data.bytes ?? Uint8List(0),
          fileName: data.item?.name ?? '',
          text: data.text,
          onChanged: onSpreadsheetChanged,
        );
      case RemoteFilePreviewKind.pdf:
        return _PdfPreview(
          key: ValueKey('pdf-${data.item?.path}'),
          bytes: data.bytes ?? Uint8List(0),
        );
      case RemoteFilePreviewKind.binary:
        return _PreviewMessage(
          icon: Icons.insert_drive_file,
          title: 'No inline preview',
          message: data.message ?? 'This file type cannot be previewed inline.',
        );
      case RemoteFilePreviewKind.error:
        return _PreviewMessage(
          icon: Icons.error_outline,
          title: 'Preview failed',
          message: data.message ?? 'Unable to preview this file.',
        );
    }
  }

  Widget _buildTextEditor(BuildContext context) {
    final controller = editorController;
    if (controller == null) {
      return SingleChildScrollView(
        key: ValueKey('text-fallback-${data.item?.path}'),
        padding: const EdgeInsets.all(12),
        child: SelectableText(
          data.text?.isEmpty ?? true ? '[Empty file]' : data.text!,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.35),
        ),
      );
    }

    final lineCount = '\n'.allMatches(controller.text).length + 1;

    return Padding(
      key: ValueKey('editor-${data.item?.path}'),
      padding: const EdgeInsets.all(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (data.truncated)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              margin: const EdgeInsets.only(bottom: 8),
              decoration: BoxDecoration(
                color: Colors.amber.shade900.withValues(alpha: 0.2),
                border: Border.all(color: Colors.amber.shade700),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Row(
                children: [
                  Icon(Icons.warning_amber_rounded, color: Colors.amber.shade300, size: 16),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'File is too large to edit safely in the sidebar. Showing a read-only preview.',
                      style: TextStyle(color: Colors.amber.shade100, fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
          Expanded(
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: AppPalette.backgroundDeep,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppPalette.border),
              ),
              child: CallbackShortcuts(
                bindings: {
                  const SingleActivator(LogicalKeyboardKey.tab): () {
                    if (data.truncated) return; // Ignore tab insertions in read-only
                    final val = controller.value;
                    final text = val.text;
                    final selection = val.selection;
                    if (selection.isValid) {
                      final newText = text.replaceRange(selection.start, selection.end, '  ');
                      final newSelection = TextSelection.collapsed(offset: selection.start + 2);
                      controller.value = TextEditingValue(
                        text: newText,
                        selection: newSelection,
                      );
                    }
                  },
                  const SingleActivator(LogicalKeyboardKey.keyF, control: true): () {
                    onToggleFindBar?.call();
                  },
                  const SingleActivator(LogicalKeyboardKey.keyH, control: true): () {
                    onToggleReplace?.call();
                  },
                  const SingleActivator(LogicalKeyboardKey.keyG, control: true): () {
                    onGoToLine?.call();
                  },
                  const SingleActivator(LogicalKeyboardKey.keyS, control: true): () {
                    onSave?.call();
                  },
                },
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Container(
                      width: 45,
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      decoration: BoxDecoration(
                        color: Colors.transparent,
                        border: Border(right: BorderSide(color: AppPalette.border)),
                      ),
                      child: SingleChildScrollView(
                        controller: lineScrollController,
                        physics: const NeverScrollableScrollPhysics(),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: List.generate(lineCount, (index) {
                            return SizedBox(
                              height: 16.2,
                              width: double.infinity,
                              child: Text(
                                '${index + 1}',
                                textAlign: TextAlign.right,
                                style: TextStyle(
                                  fontFamily: 'monospace',
                                  fontSize: 12,
                                  height: 1.35,
                                  color: AppPalette.textMuted,
                                ),
                              ),
                            );
                          }),
                        ),
                      ),
                    ),
                    Expanded(
                      child: TextField(
                        controller: controller,
                        scrollController: editorScrollController,
                        readOnly: data.truncated,
                        expands: true,
                        minLines: null,
                        maxLines: null,
                        keyboardType: TextInputType.multiline,
                        textAlignVertical: TextAlignVertical.top,
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.35),
                        decoration: const InputDecoration(
                          border: InputBorder.none,
                          contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                          hintText: 'Empty file',
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPager(BuildContext context, RemoteFileItem item) {
    const maxBytes = 2 * 1024 * 1024;
    final totalSize = item.sizeBytes;
    final currentPage = (currentOffset / maxBytes).floor() + 1;
    final totalPages = (totalSize / maxBytes).ceil();

    return Container(
      color: AppPalette.surfaceSoft,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          IconButton(
            icon: const Icon(Icons.first_page, size: 18),
            onPressed: currentPage <= 1 ? null : () => onPageChanged?.call(0),
            tooltip: 'First Page',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
          ),
          const SizedBox(width: 8),
          IconButton(
            icon: const Icon(Icons.chevron_left, size: 18),
            onPressed: currentPage <= 1 ? null : () => onPageChanged?.call((currentPage - 2) * maxBytes),
            tooltip: 'Previous Page',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
          ),
          const SizedBox(width: 16),
          Text(
            'Page $currentPage of $totalPages (showing bytes ${_formatBytes(currentOffset)} - ${_formatBytes(min(currentOffset + maxBytes, totalSize))} of ${_formatBytes(totalSize)})',
            style: TextStyle(fontSize: 12, color: AppPalette.textSecondary),
          ),
          const SizedBox(width: 16),
          IconButton(
            icon: const Icon(Icons.chevron_right, size: 18),
            onPressed: currentPage >= totalPages ? null : () => onPageChanged?.call(currentPage * maxBytes),
            tooltip: 'Next Page',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
          ),
          const SizedBox(width: 8),
          IconButton(
            icon: const Icon(Icons.last_page, size: 18),
            onPressed: currentPage >= totalPages ? null : () => onPageChanged?.call((totalPages - 1) * maxBytes),
            tooltip: 'Last Page',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
          ),
        ],
      ),
    );
  }

  String _formatBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
}

class _PreviewMessage extends StatelessWidget {
  final IconData icon;
  final String title;
  final String message;

  const _PreviewMessage({
    required this.icon,
    required this.title,
    required this.message,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Card(
          color: AppPalette.surfaceElevated,
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 42),
                const SizedBox(height: 12),
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                Text(
                  message,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white70),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _VideoPreview extends StatefulWidget {
  final Uint8List bytes;
  final String mimeType;

  const _VideoPreview({
    super.key,
    required this.bytes,
    required this.mimeType,
  });

  @override
  State<_VideoPreview> createState() => _VideoPreviewState();
}

class _VideoPreviewState extends State<_VideoPreview> {
  VideoPlayerController? _controller;
  Future<void>? _initializeFuture;

  @override
  void initState() {
    super.initState();
    _initialize();
  }

  @override
  void didUpdateWidget(covariant _VideoPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!listEquals(oldWidget.bytes, widget.bytes) || oldWidget.mimeType != widget.mimeType) {
      _disposeController();
      _initialize();
    }
  }

  void _initialize() {
    final uri = Uri.dataFromBytes(widget.bytes, mimeType: widget.mimeType);
    final controller = VideoPlayerController.networkUrl(uri);
    _controller = controller;
    _initializeFuture = controller.initialize().then((_) {
      controller.setLooping(false);
      if (mounted) setState(() {});
    });
  }

  Future<void> _disposeController() async {
    final controller = _controller;
    _controller = null;
    if (controller != null) {
      await controller.pause();
      await controller.dispose();
    }
  }

  @override
  void dispose() {
    _disposeController();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) {
      return const Center(child: CircularProgressIndicator());
    }

    return FutureBuilder<void>(
      future: _initializeFuture,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError || !controller.value.isInitialized) {
          return const _PreviewMessage(
            icon: Icons.movie_filter_outlined,
            title: 'Video cannot be played inline',
            message: 'The app loaded the video bytes, but the current platform/player cannot decode this format.',
          );
        }

        return Column(
          children: [
            Expanded(
              child: Center(
                child: AspectRatio(
                  aspectRatio: controller.value.aspectRatio == 0 ? 16 / 9 : controller.value.aspectRatio,
                  child: VideoPlayer(controller),
                ),
              ),
            ),
            Container(
              color: AppPalette.surface,
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
              child: Row(
                children: [
                  IconButton.filledTonal(
                    onPressed: () {
                      setState(() {
                        controller.value.isPlaying ? controller.pause() : controller.play();
                      });
                    },
                    icon: Icon(controller.value.isPlaying ? Icons.pause : Icons.play_arrow),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: VideoProgressIndicator(
                      controller,
                      allowScrubbing: true,
                      padding: const EdgeInsets.symmetric(vertical: 8),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(_formatDuration(controller.value.position)),
                  const Text(' / '),
                  Text(_formatDuration(controller.value.duration)),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  String _formatDuration(Duration duration) {
    final hours = duration.inHours;
    final minutes = duration.inMinutes.remainder(60).toString().padLeft(2, '0');
    final seconds = duration.inSeconds.remainder(60).toString().padLeft(2, '0');
    if (hours > 0) return '$hours:$minutes:$seconds';
    return '$minutes:$seconds';
  }
}



class _RenameDialog extends StatefulWidget {
  final String initialName;

  const _RenameDialog({required this.initialName});

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final TextEditingController controller;

  @override
  void initState() {
    super.initState();
    controller = TextEditingController(text: widget.initialName);
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Rename'),
      content: TextField(
        controller: controller,
        autofocus: true,
        decoration: const InputDecoration(labelText: 'New name'),
        onSubmitted: (_) => Navigator.of(context).pop(controller.text.trim()),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(controller.text.trim()),
          child: const Text('Rename'),
        ),
      ],
    );
  }
}

class _CreateItemDialog extends StatefulWidget {
  final bool isFolder;

  const _CreateItemDialog({required this.isFolder});

  @override
  State<_CreateItemDialog> createState() => _CreateItemDialogState();
}

class _CreateItemDialogState extends State<_CreateItemDialog> {
  late final TextEditingController controller;

  @override
  void initState() {
    super.initState();
    controller = TextEditingController();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.isFolder ? 'New Folder' : 'New File';
    final label = widget.isFolder ? 'Folder name' : 'File name';

    return AlertDialog(
      title: Text(title),
      content: TextField(
        controller: controller,
        autofocus: true,
        decoration: InputDecoration(
          labelText: label,
          hintText: widget.isFolder ? 'e.g., new_folder' : 'e.g., new_file.txt',
        ),
        onSubmitted: (_) => Navigator.of(context).pop(controller.text.trim()),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(controller.text.trim()),
          child: const Text('Create'),
        ),
      ],
    );
  }
}

class _SpreadsheetPreview extends StatefulWidget {
  final Uint8List bytes;
  final String fileName;
  final String? text;
  final ValueChanged<String>? onChanged;

  const _SpreadsheetPreview({
    super.key,
    required this.bytes,
    required this.fileName,
    this.text,
    this.onChanged,
  });

  @override
  State<_SpreadsheetPreview> createState() => _SpreadsheetPreviewState();
}

class _SpreadsheetPreviewState extends State<_SpreadsheetPreview> {
  List<List<String>> _allRows = [];
  List<List<String>> _filteredRows = [];
  List<int> _filteredRowIndices = [];
  String _searchQuery = "";
  bool _loading = true;
  String? _error;

  int? _editingRow;
  int? _editingCol;
  final TextEditingController _cellEditController = TextEditingController();
  final FocusNode _cellEditFocusNode = FocusNode();

  Point<int>? _selectionStart;
  Point<int>? _selectionEnd;

  @override
  void initState() {
    super.initState();
    _parseData();
  }

  @override
  void dispose() {
    _cellEditController.dispose();
    _cellEditFocusNode.dispose();
    super.dispose();
  }

  void _parseData() {
    try {
      final ext = widget.fileName.split('.').last.toLowerCase();
      if (ext == 'xlsx' || ext == 'xls') {
        _allRows = _parseExcel(widget.bytes);
      } else {
        final isTsv = ext == 'tsv';
        final csvText = widget.text ?? utf8.decode(widget.bytes, allowMalformed: true);
        _allRows = _parseCsv(csvText, separator: isTsv ? '\t' : ',');
      }
      _filteredRows = List.from(_allRows);
      _filteredRowIndices = List.generate(_allRows.length, (i) => i);
      _loading = false;
    } catch (e) {
      _error = e.toString();
      _loading = false;
    }
  }

  List<List<String>> _parseExcel(Uint8List bytes) {
    try {
      final excel = excel_pkg.Excel.decodeBytes(bytes);
      if (excel.tables.isEmpty) return [];
      final sheetName = excel.tables.keys.first;
      final table = excel.tables[sheetName];
      if (table == null) return [];

      final rows = <List<String>>[];
      for (final row in table.rows) {
        final rowData = <String>[];
        for (final cell in row) {
          if (cell == null) {
            rowData.add('');
          } else {
            rowData.add(cell.value?.toString() ?? '');
          }
        }
        rows.add(rowData);
      }
      return rows;
    } catch (e) {
      return [['Error parsing Excel file', e.toString()]];
    }
  }

  List<List<String>> _parseCsv(String text, {String separator = ','}) {
    final lines = <List<String>>[];
    final buffer = StringBuffer();
    var row = <String>[];
    var inQuotes = false;

    for (var i = 0; i < text.length; i++) {
      final char = text[i];
      if (inQuotes) {
        if (char == '"') {
          if (i + 1 < text.length && text[i + 1] == '"') {
            buffer.write('"');
            i++; // Skip second quote
          } else {
            inQuotes = false;
          }
        } else {
          buffer.write(char);
        }
      } else {
        if (char == '"') {
          inQuotes = true;
        } else if (char == separator) {
          row.add(buffer.toString());
          buffer.clear();
        } else if (char == '\n' || char == '\r') {
          if (char == '\r' && i + 1 < text.length && text[i + 1] == '\n') {
            i++; // Skip \n
          }
          row.add(buffer.toString());
          buffer.clear();
          lines.add(row);
          row = [];
        } else {
          buffer.write(char);
        }
      }
    }
    if (buffer.isNotEmpty || row.isNotEmpty) {
      row.add(buffer.toString());
      lines.add(row);
    }
    return lines.where((r) => r.isNotEmpty).toList();
  }

  void _filterRows(String query) {
    setState(() {
      _searchQuery = query;
      if (query.trim().isEmpty) {
        _filteredRows = List.from(_allRows);
        _filteredRowIndices = List.generate(_allRows.length, (i) => i);
      } else {
        final lowerQuery = query.toLowerCase();
        if (_allRows.isEmpty) {
          _filteredRows = [];
          _filteredRowIndices = [];
          return;
        }
        final header = _allRows.first;
        final dataRows = _allRows.sublist(1);
        final filteredData = <List<String>>[];
        final filteredIndices = <int>[0];
        for (var i = 0; i < dataRows.length; i++) {
          final row = dataRows[i];
          if (row.any((cell) => cell.toLowerCase().contains(lowerQuery))) {
            filteredData.add(row);
            filteredIndices.add(i + 1);
          }
        }
        _filteredRows = [header, ...filteredData];
        _filteredRowIndices = filteredIndices;
      }
    });
  }

  bool _isCellSelected(int rowIndex, int colIndex) {
    if (_selectionStart == null || _selectionEnd == null) return false;
    final minR = min(_selectionStart!.x, _selectionEnd!.x);
    final maxR = max(_selectionStart!.x, _selectionEnd!.x);
    final minC = min(_selectionStart!.y, _selectionEnd!.y);
    final maxC = max(_selectionStart!.y, _selectionEnd!.y);
    return rowIndex >= minR && rowIndex <= maxR && colIndex >= minC && colIndex <= maxC;
  }

  void _handleCellTap(int rowIndex, int colIndex, String val) {
    final isShiftPressed = HardwareKeyboard.instance.isShiftPressed;
    setState(() {
      if (isShiftPressed && _selectionStart != null) {
        _selectionEnd = Point(rowIndex, colIndex);
      } else {
        _selectionStart = Point(rowIndex, colIndex);
        _selectionEnd = Point(rowIndex, colIndex);
      }
      if (_editingRow != rowIndex || _editingCol != colIndex) {
        _editingRow = null;
        _editingCol = null;
      }
    });
  }

  void _handleRowHeaderTap(int rowIndex, int colCount) {
    final isShiftPressed = HardwareKeyboard.instance.isShiftPressed;
    setState(() {
      if (isShiftPressed && _selectionStart != null) {
        _selectionStart = Point(_selectionStart!.x, 0);
        _selectionEnd = Point(rowIndex, colCount - 1);
      } else {
        _selectionStart = Point(rowIndex, 0);
        _selectionEnd = Point(rowIndex, colCount - 1);
      }
      _editingRow = null;
      _editingCol = null;
    });
  }

  void _handleCellDoubleTap(int rowIndex, int colIndex, String val) {
    final ext = widget.fileName.split('.').last.toLowerCase();
    if (ext == 'xlsx' || ext == 'xls') {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Excel files are view-only. Convert to CSV to edit.')),
      );
      return;
    }
    setState(() {
      _editingRow = rowIndex;
      _editingCol = colIndex;
      _cellEditController.text = val;
      _cellEditController.selection = TextSelection(baseOffset: 0, extentOffset: val.length);
      _cellEditFocusNode.requestFocus();
    });
  }

  void _submitCellEdit(int rowIndex, int colIndex, String newVal) {
    if (_editingRow != rowIndex || _editingCol != colIndex) return;
    setState(() {
      _editingRow = null;
      _editingCol = null;

      final realRowIndex = _filteredRowIndices[rowIndex + 1];
      
      _allRows[realRowIndex][colIndex] = newVal;
      if (_searchQuery.trim().isNotEmpty) {
        _filteredRows[rowIndex + 1][colIndex] = newVal;
      }

      final ext = widget.fileName.split('.').last.toLowerCase();
      final isTsv = ext == 'tsv';
      final newCsvText = _toCsv(_allRows, separator: isTsv ? '\t' : ',');
      widget.onChanged?.call(newCsvText);
    });
  }

  String _toCsv(List<List<String>> rows, {String separator = ','}) {
    return rows.map((row) {
      return row.map((cell) {
        if (cell.contains(separator) || cell.contains('"') || cell.contains('\n') || cell.contains('\r')) {
          return '"${cell.replaceAll('"', '""')}"';
        }
        return cell;
      }).join(separator);
    }).join('\n');
  }

  void _copySelectedRange() {
    if (_selectionStart == null || _selectionEnd == null) return;
    final minR = min(_selectionStart!.x, _selectionEnd!.x);
    final maxR = max(_selectionStart!.x, _selectionEnd!.x);
    final minC = min(_selectionStart!.y, _selectionEnd!.y);
    final maxC = max(_selectionStart!.y, _selectionEnd!.y);

    final displayRows = _searchQuery.trim().isEmpty ? _allRows : _filteredRows;
    final dataRows = displayRows.length > 1 ? displayRows.sublist(1) : <List<String>>[];

    final buffer = StringBuffer();
    for (var r = minR; r <= maxR; r++) {
      if (r >= dataRows.length) continue;
      final rowVals = <String>[];
      final row = dataRows[r];
      for (var c = minC; c <= maxC; c++) {
        if (c >= row.length) continue;
        rowVals.add(row[c]);
      }
      buffer.writeln(rowVals.join('\t'));
    }
    Clipboard.setData(ClipboardData(text: buffer.toString().trimRight()));
    
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('Copied range: (${minR+1},${minC+1}) to (${maxR+1},${maxC+1})'),
        duration: const Duration(seconds: 1),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.error_outline, color: AppPalette.danger, size: 48),
              const SizedBox(height: 12),
              Text('Error rendering spreadsheet:', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 6),
              Text(_error!, style: TextStyle(color: AppPalette.textMuted, fontSize: 13), textAlign: TextAlign.center),
            ],
          ),
        ),
      );
    }
    if (_allRows.isEmpty) {
      return const Center(child: Text('No data found in spreadsheet'));
    }

    final headers = _allRows.first;
    final displayRows = _searchQuery.trim().isEmpty ? _allRows : _filteredRows;
    final headerRow = displayRows.first;
    final dataRows = displayRows.length > 1 ? displayRows.sublist(1) : <List<String>>[];

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyC, control: true): () {
          _copySelectedRange();
        },
      },
      child: Focus(
        autofocus: true,
        child: Column(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              color: AppPalette.surface,
              child: Row(
                children: [
                  Expanded(
                    child: SizedBox(
                      height: 36,
                      child: TextField(
                        onChanged: _filterRows,
                        decoration: InputDecoration(
                          hintText: 'Search rows...',
                          prefixIcon: Icon(Icons.search, size: 16, color: AppPalette.textMuted),
                          contentPadding: const EdgeInsets.symmetric(vertical: 0, horizontal: 10),
                          fillColor: AppPalette.backgroundDeep,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(6),
                            borderSide: BorderSide(color: AppPalette.border),
                          ),
                          enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(6),
                            borderSide: BorderSide(color: AppPalette.border),
                          ),
                        ),
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                  ),
                  const SizedBox(width: 16),
                  Text(
                    'Rows: ${dataRows.length} / ${_allRows.length - 1} | Columns: ${headers.length}',
                    style: TextStyle(fontSize: 12, color: AppPalette.textMuted),
                  ),
                ],
              ),
            ),
            Expanded(
              child: Container(
                color: AppPalette.backgroundDeep,
                child: SingleChildScrollView(
                  scrollDirection: Axis.vertical,
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Theme(
                      data: Theme.of(context).copyWith(
                        dividerColor: AppPalette.border,
                      ),
                      child: DataTable(
                        headingRowColor: WidgetStateProperty.all(AppPalette.surface),
                        dataRowMinHeight: 28,
                        dataRowMaxHeight: 36,
                        headingRowHeight: 36,
                        horizontalMargin: 12,
                        columnSpacing: 20,
                        columns: [
                          DataColumn(
                            label: GestureDetector(
                              onTap: () {
                                setState(() {
                                    _selectionStart = const Point(0, 0);
                                    _selectionEnd = Point(dataRows.length - 1, headerRow.length - 1);
                                });
                              },
                              child: Text(
                                '#',
                                style: TextStyle(
                                  color: AppPalette.accent,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 12,
                                ),
                              ),
                            ),
                          ),
                          ...headerRow.map((h) => DataColumn(
                            label: Text(
                              h.isEmpty ? 'Untitled' : h,
                              style: TextStyle(
                                color: AppPalette.textPrimary,
                                fontWeight: FontWeight.bold,
                                fontSize: 12,
                              ),
                            ),
                          )),
                        ],
                        rows: List<DataRow>.generate(dataRows.length, (index) {
                          final rowData = dataRows[index];
                          final isEven = index % 2 == 0;
                          return DataRow(
                            color: WidgetStateProperty.all(
                              isEven ? AppPalette.backgroundDeep : AppPalette.surfaceSoft.withValues(alpha: 0.3),
                            ),
                            cells: [
                              DataCell(
                                GestureDetector(
                                  onTap: () => _handleRowHeaderTap(index, headerRow.length),
                                  child: Container(
                                    alignment: Alignment.center,
                                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                                    color: Colors.transparent,
                                    child: Text(
                                      '${index + 1}',
                                      style: TextStyle(
                                        color: AppPalette.textMuted,
                                        fontSize: 11,
                                        fontFamily: 'monospace',
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                              ...List<DataCell>.generate(headerRow.length, (colIndex) {
                                final val = colIndex < rowData.length ? rowData[colIndex] : '';
                                final isSelected = _isCellSelected(index, colIndex);
                                final isEditing = _editingRow == index && _editingCol == colIndex;

                                return DataCell(
                                  GestureDetector(
                                    onTap: () => _handleCellTap(index, colIndex, val),
                                    onDoubleTap: () => _handleCellDoubleTap(index, colIndex, val),
                                    child: Container(
                                      alignment: Alignment.centerLeft,
                                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                                      decoration: BoxDecoration(
                                        color: isSelected
                                            ? AppPalette.accent.withValues(alpha: 0.15)
                                            : isEditing
                                                ? AppPalette.surface
                                                : Colors.transparent,
                                        border: isSelected
                                            ? Border.all(color: AppPalette.accent, width: 1)
                                            : isEditing
                                                ? Border.all(color: AppPalette.accent, width: 2)
                                                : null,
                                        borderRadius: BorderRadius.circular(2),
                                      ),
                                      child: isEditing
                                          ? SizedBox(
                                              width: 150,
                                              child: TextField(
                                                controller: _cellEditController,
                                                focusNode: _cellEditFocusNode,
                                                autofocus: true,
                                                style: TextStyle(fontSize: 12, color: AppPalette.textPrimary),
                                                decoration: const InputDecoration(
                                                  border: InputBorder.none,
                                                  isDense: true,
                                                  contentPadding: EdgeInsets.zero,
                                                ),
                                                onSubmitted: (newVal) => _submitCellEdit(index, colIndex, newVal),
                                                onTapOutside: (_) => _submitCellEdit(index, colIndex, _cellEditController.text),
                                              ),
                                            )
                                          : Text(
                                              val,
                                              style: TextStyle(
                                                fontSize: 12,
                                                color: AppPalette.textSecondary,
                                              ),
                                            ),
                                    ),
                                  ),
                                );
                              }),
                            ],
                          );
                        }),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PdfPreview extends StatefulWidget {
  final Uint8List bytes;

  const _PdfPreview({
    super.key,
    required this.bytes,
  });

  @override
  State<_PdfPreview> createState() => _PdfPreviewState();
}

class _PdfPreviewState extends State<_PdfPreview> {
  late final PdfController _pdfController;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    try {
      _pdfController = PdfController(
        document: PdfDocument.openData(widget.bytes),
      );
      _loading = false;
    } catch (e) {
      _error = e.toString();
      _loading = false;
    }
  }

  @override
  void dispose() {
    _pdfController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.error_outline, color: AppPalette.danger, size: 48),
              const SizedBox(height: 12),
              Text('Error rendering PDF:', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 6),
              Text(_error!, style: TextStyle(color: AppPalette.textMuted, fontSize: 13), textAlign: TextAlign.center),
            ],
          ),
        ),
      );
    }
    return Container(
      color: AppPalette.backgroundDeep,
      child: PdfView(
        controller: _pdfController,
        scrollDirection: Axis.vertical,
      ),
    );
  }
}

class _CommandPaletteDialog extends StatefulWidget {
  final List<_CommandItem> commands;

  const _CommandPaletteDialog({required this.commands});

  @override
  State<_CommandPaletteDialog> createState() => _CommandPaletteDialogState();
}

class _CommandPaletteDialogState extends State<_CommandPaletteDialog> {
  final TextEditingController _searchController = TextEditingController();
  List<_CommandItem> _filtered = [];
  int _selectedIndex = 0;

  @override
  void initState() {
    super.initState();
    _filtered = widget.commands;
    _searchController.addListener(_filter);
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _filter() {
    final query = _searchController.text.toLowerCase().trim();
    setState(() {
      if (query.isEmpty) {
        _filtered = widget.commands;
      } else {
        _filtered = widget.commands
            .where((cmd) => cmd.name.toLowerCase().contains(query))
            .toList();
      }
      _selectedIndex = 0;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: AppPalette.surfaceElevated,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      alignment: Alignment.topCenter,
      insetPadding: const EdgeInsets.only(top: 50, left: 40, right: 40),
      child: Container(
        width: 500,
        constraints: const BoxConstraints(maxHeight: 350),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Focus(
              onKeyEvent: (node, event) {
                if (event is KeyDownEvent) {
                  if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
                    setState(() {
                      if (_filtered.isNotEmpty) {
                        _selectedIndex = (_selectedIndex + 1) % _filtered.length;
                      }
                    });
                    return KeyEventResult.handled;
                  } else if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
                    setState(() {
                      if (_filtered.isNotEmpty) {
                        _selectedIndex = (_selectedIndex - 1 + _filtered.length) % _filtered.length;
                      }
                    });
                    return KeyEventResult.handled;
                  } else if (event.logicalKey == LogicalKeyboardKey.enter) {
                    if (_filtered.isNotEmpty && _selectedIndex < _filtered.length) {
                      final action = _filtered[_selectedIndex].action;
                      Navigator.pop(context);
                      action();
                    }
                    return KeyEventResult.handled;
                  } else if (event.logicalKey == LogicalKeyboardKey.escape) {
                    Navigator.pop(context);
                    return KeyEventResult.handled;
                  }
                }
                return KeyEventResult.ignored;
              },
              child: TextField(
                controller: _searchController,
                autofocus: true,
                style: const TextStyle(fontSize: 14),
                decoration: const InputDecoration(
                  hintText: 'Type a command to search...',
                  contentPadding: EdgeInsets.all(12),
                  border: InputBorder.none,
                ),
              ),
            ),
            Divider(height: 1, color: AppPalette.border),
            if (_filtered.isEmpty)
              Padding(
                padding: EdgeInsets.all(16),
                child: Text('No commands matching your query.', style: TextStyle(color: AppPalette.textMuted)),
              )
            else
              Flexible(
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: _filtered.length,
                  itemBuilder: (context, index) {
                    final item = _filtered[index];
                    final isSelected = index == _selectedIndex;
                    return InkWell(
                      onTap: () {
                        Navigator.pop(context);
                        item.action();
                      },
                      child: Container(
                        color: isSelected ? AppPalette.surfaceSoft : Colors.transparent,
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                        child: Row(
                          children: [
                            Icon(
                              Icons.arrow_right,
                              size: 16,
                              color: isSelected ? AppPalette.accent : Colors.transparent,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              item.name,
                              style: TextStyle(
                                fontSize: 13,
                                color: isSelected ? AppPalette.textPrimary : AppPalette.textSecondary,
                                fontWeight: isSelected ? FontWeight.w500 : FontWeight.normal,
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _CommandItem {
  final String name;
  final VoidCallback action;

  const _CommandItem({required this.name, required this.action});
}

