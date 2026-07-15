part of ssh_dashboard;

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
  static const int _maxTextPreviewBytes = 512 * 1024;
  static const int _maxImagePreviewBytes = 16 * 1024 * 1024;
  static const int _maxVideoPreviewBytes = 80 * 1024 * 1024;

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

  bool get _canEditCurrentPreview {
    final kind = preview.kind;
    return editorItem != null &&
        !preview.truncated &&
        (kind == RemoteFilePreviewKind.text || kind == RemoteFilePreviewKind.markdown);
  }

  @override
  void initState() {
    super.initState();
    editorController.addListener(_handleEditorChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) => openPath('~'));
  }

  @override
  void dispose() {
    pathController.dispose();
    editorController.removeListener(_handleEditorChanged);
    editorController.dispose();
    super.dispose();
  }

  void _handleEditorChanged() {
    if (_suppressEditorDirty || editorItem == null || editorDirty) return;
    setState(() {
      editorDirty = true;
    });
  }

  void _setEditorText(RemoteFileItem item, String text) {
    _suppressEditorDirty = true;
    editorController.text = text;
    editorController.selection = const TextSelection.collapsed(offset: 0);
    _suppressEditorDirty = false;
    editorItem = item;
    editorDirty = false;
  }

  void _clearEditorState() {
    _suppressEditorDirty = true;
    editorController.clear();
    _suppressEditorDirty = false;
    editorItem = null;
    editorDirty = false;
    editorSaving = false;
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

  Future<void> openFile(RemoteFileItem item) async {
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
        );
        next = RemoteFilePreviewData.text(
          item: item,
          text: text,
          truncated: text.contains('[Preview truncated:'),
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
        if ((next.kind == RemoteFilePreviewKind.text || next.kind == RemoteFilePreviewKind.markdown) && !next.truncated) {
          _setEditorText(item, next.text ?? '');
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
      'csv',
      'tsv',
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

    return Column(
      children: [
        Container(
          decoration: const BoxDecoration(
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
                    tooltip: 'Parent folder',
                    onPressed: directoryLoading ? null : () => openPath(_parentOf(currentPath)),
                    icon: const Icon(Icons.arrow_upward_outlined),
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: TextField(
                      controller: pathController,
                      decoration: const InputDecoration(
                        labelText: 'Remote path',
                        prefixIcon: Icon(Icons.folder_outlined, size: 16, color: AppPalette.accent),
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                      onSubmitted: openPath,
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton.tonalIcon(
                    onPressed: directoryLoading ? null : () => openPath(pathController.text),
                    icon: const Icon(Icons.folder_open_outlined),
                    label: const Text('Open'),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    tooltip: 'New File',
                    icon: const Icon(Icons.note_add_outlined),
                    onPressed: directoryLoading ? null : _createNewFile,
                  ),
                  IconButton(
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
          child: Row(
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
                                                          style: const TextStyle(
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
                            decoration: BoxDecoration(color: Colors.black.withOpacity(0.08)),
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
                  ),
                ),
            ],
          ),
        ),
        if (!isWide && preview.item != null)
          SizedBox(
            height: 300,
            child: _FilePreviewPane(
              data: preview,
              loading: previewLoading,
              onOpenFullscreen: () => _showPreviewDialog(preview),
              editorController: editorController,
              canEdit: _canEditCurrentPreview,
              editorDirty: editorDirty,
              editorSaving: editorSaving,
              onSave: _saveCurrentEditor,
              onReload: _reloadCurrentEditor,
            ),
          ),
      ],
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
            style: const TextStyle(
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
        const Icon(
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
              style: const TextStyle(
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
  });

  @override
  Widget build(BuildContext context) {
    final item = data.item;
    final titlePrefix = canEdit ? 'Editor' : 'Preview';
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
                Expanded(
                  child: Text(
                    item == null ? 'Preview' : '$titlePrefix: ${item.name}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ),
                if (canEdit)
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
                if (canEdit)
                  IconButton(
                    tooltip: 'Reload from remote',
                    onPressed: editorSaving ? null : onReload,
                    icon: const Icon(Icons.refresh, size: 18),
                  ),
                if (canEdit)
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
          Expanded(
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 180),
              child: loading
                  ? const Center(key: ValueKey('preview-loading'), child: CircularProgressIndicator())
                  : _buildPreviewBody(context),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPreviewBody(BuildContext context) {
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
        if (canEdit) return _buildTextEditor(context);
        return _MarkdownLitePreview(
          key: ValueKey('markdown-${data.item?.path}'),
          text: data.text?.isEmpty ?? true ? '[Empty file]' : data.text!,
        );
      case RemoteFilePreviewKind.text:
        if (canEdit) return _buildTextEditor(context);
        return SingleChildScrollView(
          key: ValueKey('text-${data.item?.path}'),
          padding: const EdgeInsets.all(12),
          child: SelectableText(
            data.text?.isEmpty ?? true ? '[Empty file]' : data.text!,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.35),
          ),
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

    return Padding(
      key: ValueKey('editor-${data.item?.path}'),
      padding: const EdgeInsets.all(10),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppPalette.backgroundDeep,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppPalette.border),
        ),
        child: TextField(
          controller: controller,
          expands: true,
          minLines: null,
          maxLines: null,
          keyboardType: TextInputType.multiline,
          textAlignVertical: TextAlignVertical.top,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.35),
          decoration: const InputDecoration(
            border: InputBorder.none,
            contentPadding: EdgeInsets.all(12),
            hintText: 'Empty file',
          ),
        ),
      ),
    );
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
          return _PreviewMessage(
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

class _MarkdownLitePreview extends StatelessWidget {
  final String text;

  const _MarkdownLitePreview({
    super.key,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    final lines = const LineSplitter().convert(text);
    final widgets = <Widget>[];
    final codeBuffer = <String>[];
    bool inCodeBlock = false;

    void flushCodeBlock() {
      if (codeBuffer.isEmpty) return;
      widgets.add(
        Container(
          width: double.infinity,
          margin: const EdgeInsets.symmetric(vertical: 8),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AppPalette.surfaceElevated,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppPalette.border),
          ),
          child: SelectableText(
            codeBuffer.join('\n'),
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.35),
          ),
        ),
      );
      codeBuffer.clear();
    }

    for (final rawLine in lines) {
      final line = rawLine.replaceAll('\t', '    ');
      final trimmed = line.trimRight();

      if (trimmed.trimLeft().startsWith('```')) {
        if (inCodeBlock) {
          inCodeBlock = false;
          flushCodeBlock();
        } else {
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBuffer.add(line);
        continue;
      }

      if (trimmed.trim().isEmpty) {
        widgets.add(const SizedBox(height: 8));
        continue;
      }

      final heading = RegExp(r'^(#{1,6})\s+(.*)$').firstMatch(trimmed);
      if (heading != null) {
        final level = heading.group(1)!.length;
        final content = heading.group(2)!;
        final size = switch (level) {
          1 => 26.0,
          2 => 22.0,
          3 => 18.0,
          4 => 16.0,
          _ => 14.0,
        };
        widgets.add(Padding(
          padding: EdgeInsets.only(top: level <= 2 ? 14 : 10, bottom: 6),
          child: SelectableText(
            content,
            style: TextStyle(fontSize: size, fontWeight: FontWeight.w700, height: 1.2),
          ),
        ));
        continue;
      }

      final bullet = RegExp(r'^\s*[-*+]\s+(.*)$').firstMatch(trimmed);
      if (bullet != null) {
        widgets.add(Padding(
          padding: const EdgeInsets.only(left: 8, top: 3, bottom: 3),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('•  '),
              Expanded(child: SelectableText(bullet.group(1)!)),
            ],
          ),
        ));
        continue;
      }

      final numbered = RegExp(r'^\s*\d+[.)]\s+(.*)$').firstMatch(trimmed);
      if (numbered != null) {
        widgets.add(Padding(
          padding: const EdgeInsets.only(left: 8, top: 3, bottom: 3),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('•  '),
              Expanded(child: SelectableText(numbered.group(1)!)),
            ],
          ),
        ));
        continue;
      }

      if (trimmed.trimLeft().startsWith('>')) {
        widgets.add(Container(
          width: double.infinity,
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: AppPalette.surfaceElevated,
            border: Border(left: BorderSide(color: AppPalette.accent, width: 3)),
          ),
          child: SelectableText(trimmed.trimLeft().replaceFirst(RegExp(r'^>\s?'), '')),
        ));
        continue;
      }

      widgets.add(Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: SelectableText(trimmed, style: const TextStyle(height: 1.35)),
      ));
    }

    if (inCodeBlock) flushCodeBlock();

    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: SelectionArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: widgets,
        ),
      ),
    );
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

