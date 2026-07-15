library ssh_dashboard;

import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;
import 'dart:typed_data';

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
    return ChangeNotifierProvider(
      create: (_) => SSHProvider(),
      child: const SSHDashboardApp(),
    );
  }
}

class SSHDashboardApp extends StatelessWidget {
  const SSHDashboardApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SSH Dashboard Hermes',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        colorScheme: const ColorScheme.dark(
          primary: AppPalette.primary,
          secondary: AppPalette.accent,
          surface: AppPalette.surface,
          error: AppPalette.danger,
          onPrimary: AppPalette.backgroundDeep,
          onSecondary: AppPalette.backgroundDeep,
          onSurface: AppPalette.textPrimary,
        ),
        useMaterial3: true,
        scaffoldBackgroundColor: AppPalette.background,
        visualDensity: VisualDensity.adaptivePlatformDensity,
        textTheme: ThemeData.dark().textTheme.apply(
              bodyColor: AppPalette.textPrimary,
              displayColor: AppPalette.textPrimary,
            ),
        appBarTheme: const AppBarTheme(
          backgroundColor: AppPalette.backgroundDeep,
          foregroundColor: AppPalette.textPrimary,
          elevation: 0,
          centerTitle: false,
          surfaceTintColor: Colors.transparent,
        ),
        tabBarTheme: const TabBarThemeData(
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
          hintStyle: const TextStyle(color: AppPalette.textMuted),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: AppPalette.border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: AppPalette.border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: AppPalette.borderStrong, width: 1.2),
          ),
        ),
      ),
      home: const DashboardPage(),
    );
  }
}

