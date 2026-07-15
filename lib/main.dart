library cozypad;

import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;
import 'dart:math';

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:provider/provider.dart';
import 'package:xterm/xterm.dart';
import 'package:video_player/video_player.dart';
import 'package:excel/excel.dart' as excel_pkg;
import 'package:pdfx/pdfx.dart';


part 'models/models.dart';
part 'providers/ssh_provider.dart';
part 'pages/login_page.dart';
part 'pages/dashboard_page.dart';
part 'tabs/monitor_tab.dart';
part 'tabs/tasks_tab.dart';
part 'tabs/files_tab.dart';
part 'tabs/commands_tab.dart';
part 'tabs/agents_tab.dart';
part 'widgets/common_widgets.dart';
part 'hermes/hermes_models.dart';
part 'hermes/harness/hermes_harness.dart';
part 'hermes/rebuild/hermes_remote_runtime.dart';
part 'hermes/hermes_engine.dart';
part 'hermes/hermes_native_tab.dart';
part 'hermes/hermes_widgets.dart';
part 'widgets/connection_profile_widgets.dart';

TerminalTargetPlatform currentTerminalTargetPlatform() {
  if (kIsWeb) return TerminalTargetPlatform.web;

  switch (defaultTargetPlatform) {
    case TargetPlatform.android:
      return TerminalTargetPlatform.android;
    case TargetPlatform.iOS:
      return TerminalTargetPlatform.ios;
    case TargetPlatform.macOS:
      return TerminalTargetPlatform.macos;
    case TargetPlatform.windows:
      return TerminalTargetPlatform.windows;
    case TargetPlatform.linux:
      return TerminalTargetPlatform.linux;
    case TargetPlatform.fuchsia:
      return TerminalTargetPlatform.fuchsia;
  }
}

void main() {
  runApp(const MyApp());
}

/* =========================================================
   App
========================================================= */

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => SSHProvider()),
        ChangeNotifierProvider(create: (_) => SettingsNotifier()),
      ],
      child: const CozyPadApp(),
    );
  }
}

class CozyPadApp extends StatelessWidget {
  const CozyPadApp({super.key});

  @override
  Widget build(BuildContext context) {
    final settings = Provider.of<SettingsNotifier>(context);
    final theme = settings.currentTheme;
    final isLight = theme.name.contains('Light');

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.equal, control: true): () {
          settings.zoomIn();
        },
        const SingleActivator(LogicalKeyboardKey.minus, control: true): () {
          settings.zoomOut();
        },
        const SingleActivator(LogicalKeyboardKey.digit0, control: true): () {
          settings.resetZoom();
        },
      },
      child: MaterialApp(
        title: 'CozyPad',
        debugShowCheckedModeBanner: false,
        builder: (context, child) {
          return MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(settings.zoom),
            ),
            child: child!,
          );
        },
        theme: ThemeData(
          brightness: isLight ? Brightness.light : Brightness.dark,
          colorScheme: ColorScheme(
            brightness: isLight ? Brightness.light : Brightness.dark,
            primary: AppPalette.primary,
            onPrimary: AppPalette.backgroundDeep,
            secondary: AppPalette.accent,
            onSecondary: AppPalette.backgroundDeep,
            error: AppPalette.danger,
            onError: AppPalette.textPrimary,
            surface: AppPalette.surface,
            onSurface: AppPalette.textPrimary,
          ),
          useMaterial3: true,
          scaffoldBackgroundColor: AppPalette.background,
          visualDensity: VisualDensity.adaptivePlatformDensity,
          textTheme: (isLight ? ThemeData.light() : ThemeData.dark()).textTheme.apply(
                bodyColor: AppPalette.textPrimary,
                displayColor: AppPalette.textPrimary,
              ),
        appBarTheme: AppBarTheme(
          backgroundColor: AppPalette.backgroundDeep,
          foregroundColor: AppPalette.textPrimary,
          elevation: 0,
          centerTitle: false,
          surfaceTintColor: Colors.transparent,
        ),
        tabBarTheme: TabBarThemeData(
          labelColor: AppPalette.textPrimary,
          unselectedLabelColor: AppPalette.textMuted,
          indicatorColor: AppPalette.accent,
          dividerColor: Colors.transparent,
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            backgroundColor: AppPalette.textPrimary,
            foregroundColor: AppPalette.backgroundDeep,
            elevation: 0,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
        ),
        textButtonTheme: TextButtonThemeData(
          style: TextButton.styleFrom(
            foregroundColor: AppPalette.textSecondary,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
        ),
        iconButtonTheme: IconButtonThemeData(
          style: IconButton.styleFrom(
            foregroundColor: AppPalette.textSecondary,
            disabledForegroundColor: AppPalette.textMuted,
            hoverColor: AppPalette.surfaceSoft,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: AppPalette.surface,
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          hintStyle: TextStyle(color: AppPalette.textMuted),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: BorderSide(color: AppPalette.border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: BorderSide(color: AppPalette.border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: BorderSide(color: AppPalette.borderStrong, width: 1.2),
          ),
        ),
      ),
      home: DashboardPage(key: ValueKey(theme.name)),
    ),
  );
}
}

