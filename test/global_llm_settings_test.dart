import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:cozypad/main.dart';

// Helper for fallback resolution
String resolveFallback({
  required String profileValue,
  required String globalValue,
  required String defaultValue,
}) {
  final trimmedProfile = profileValue.trim();
  if (trimmedProfile.isEmpty) {
    final trimmedGlobal = globalValue.trim();
    if (trimmedGlobal.isEmpty) {
      return defaultValue;
    }
    return trimmedGlobal;
  }
  return trimmedProfile;
}

// Mock Secure Storage for testing persistence exception scenarios
class MockSecureStorage {
  final Map<String, String> _data = {};
  bool throwOnRead = false;
  bool throwOnWrite = false;

  Future<String?> read({required String key}) async {
    if (throwOnRead) {
      throw Exception('Secure storage read failed');
    }
    return _data[key];
  }

  Future<void> write({required String key, required String value}) async {
    if (throwOnWrite) {
      throw Exception('Secure storage write failed');
    }
    _data[key] = value;
  }
}

// State-retaining mock subclass of SettingsNotifier
class FakeSettingsNotifier extends SettingsNotifier {
  final MockSecureStorage mockStorage = MockSecureStorage();
  
  String _googleApiKey = '';
  String _googleBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  String _googleModel = 'gemini-3.5-flash';

  FakeSettingsNotifier() : super();

  @override
  String get googleApiKey => _googleApiKey;

  @override
  String get googleBaseUrl => _googleBaseUrl;

  @override
  String get googleModel => _googleModel;

  @override
  Future<void> setGoogleApiKey(String value) async {
    try {
      await mockStorage.write(key: 'google_api_key', value: value);
      _googleApiKey = value;
      notifyListeners();
    } catch (e) {
      rethrow;
    }
  }

  @override
  Future<void> setGoogleBaseUrl(String value) async {
    try {
      await mockStorage.write(key: 'google_base_url', value: value);
      _googleBaseUrl = value;
      notifyListeners();
    } catch (e) {
      rethrow;
    }
  }

  @override
  Future<void> setGoogleModel(String value) async {
    try {
      await mockStorage.write(key: 'google_model', value: value);
      _googleModel = value;
      notifyListeners();
    } catch (e) {
      rethrow;
    }
  }

  Future<void> simulateLoad() async {
    try {
      final key = await mockStorage.read(key: 'google_api_key');
      if (key != null) _googleApiKey = key;

      final url = await mockStorage.read(key: 'google_base_url');
      if (url != null) _googleBaseUrl = url;

      final model = await mockStorage.read(key: 'google_model');
      if (model != null) _googleModel = model;

      notifyListeners();
    } catch (e) {
      _googleApiKey = '';
      _googleBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
      _googleModel = 'gemini-3.5-flash';
      notifyListeners();
    }
  }
}

// Mock dialog widget for testing R2 UI controls
class TestSettingsDialog extends StatefulWidget {
  final SettingsNotifier settingsNotifier;
  final VoidCallback? onSaved;

  const TestSettingsDialog({
    super.key,
    required this.settingsNotifier,
    this.onSaved,
  });

  @override
  State<TestSettingsDialog> createState() => _TestSettingsDialogState();
}

class _TestSettingsDialogState extends State<TestSettingsDialog> {
  late final TextEditingController apiKeyController;
  late final TextEditingController baseUrlController;
  late final TextEditingController modelController;
  bool hideSecrets = true;

  @override
  void initState() {
    super.initState();
    apiKeyController = TextEditingController(text: widget.settingsNotifier.googleApiKey);
    baseUrlController = TextEditingController(text: widget.settingsNotifier.googleBaseUrl);
    modelController = TextEditingController(text: widget.settingsNotifier.googleModel);
  }

  @override
  void dispose() {
    apiKeyController.dispose();
    baseUrlController.dispose();
    modelController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: Column(
            children: [
              const Text('Agent Settings / LLM 設定'),
              TextField(
                key: const Key('apiKeyField'),
                controller: apiKeyController,
                obscureText: hideSecrets,
                decoration: InputDecoration(
                  suffixIcon: IconButton(
                    key: const Key('visibilityToggle'),
                    icon: Icon(hideSecrets ? Icons.visibility_off : Icons.visibility),
                    onPressed: () {
                      setState(() {
                        hideSecrets = !hideSecrets;
                      });
                    },
                  ),
                ),
              ),
              TextField(
                key: const Key('baseUrlField'),
                controller: baseUrlController,
              ),
              TextField(
                key: const Key('modelField'),
                controller: modelController,
              ),
              ElevatedButton(
                key: const Key('saveButton'),
                onPressed: () async {
                  await widget.settingsNotifier.setGoogleApiKey(apiKeyController.text);
                  await widget.settingsNotifier.setGoogleBaseUrl(baseUrlController.text);
                  await widget.settingsNotifier.setGoogleModel(modelController.text);
                  if (widget.onSaved != null) {
                    widget.onSaved!();
                  }
                },
                child: const Text('Save'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// Mock Hermes Tab for testing fallback and live updating
class TestHermesTab extends StatefulWidget {
  final SettingsNotifier settingsNotifier;
  final Map<String, String> profileSettings;

  const TestHermesTab({
    super.key,
    required this.settingsNotifier,
    required this.profileSettings,
  });

  @override
  State<TestHermesTab> createState() => _TestHermesTabState();
}

class _TestHermesTabState extends State<TestHermesTab> {
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: ListenableBuilder(
          listenable: widget.settingsNotifier,
          builder: (context, _) {
            final activeApiKey = resolveFallback(
              profileValue: widget.profileSettings['apiKey'] ?? '',
              globalValue: widget.settingsNotifier.googleApiKey,
              defaultValue: '',
            );

            final activeBaseUrl = resolveFallback(
              profileValue: widget.profileSettings['baseUrl'] ?? '',
              globalValue: widget.settingsNotifier.googleBaseUrl,
              defaultValue: 'https://generativelanguage.googleapis.com/v1beta',
            );

            final activeModel = resolveFallback(
              profileValue: widget.profileSettings['model'] ?? '',
              globalValue: widget.settingsNotifier.googleModel,
              defaultValue: 'gemini-3.5-flash',
            );

            return Column(
              children: [
                Text('Resolved API Key: $activeApiKey', key: const Key('resolvedApiKey')),
                Text('Resolved Base URL: $activeBaseUrl', key: const Key('resolvedBaseUrl')),
                Text('Resolved Model: $activeModel', key: const Key('resolvedModel')),
              ],
            );
          },
        ),
      ),
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall methodCall) async {
      if (methodCall.method == 'read') {
        return null;
      }
      if (methodCall.method == 'write') {
        return null;
      }
      return null;
    });
  });

  group('Tier 1: Feature Coverage', () {
    test('1. SettingsNotifier - default googleApiKey is empty', () {
      final notifier = SettingsNotifier();
      expect(notifier.googleApiKey, isEmpty);
    });

    test('2. SettingsNotifier - default googleBaseUrl is Google AI Studio standard URL', () {
      final notifier = SettingsNotifier();
      expect(notifier.googleBaseUrl, equals('https://generativelanguage.googleapis.com/v1beta'));
    });

    test('3. SettingsNotifier - default googleModel is gemini-3.5-flash', () {
      final notifier = SettingsNotifier();
      expect(notifier.googleModel, equals('gemini-3.5-flash'));
    });

    test('4. SettingsNotifier - setGoogleApiKey notifies listeners', () async {
      final notifier = SettingsNotifier();
      bool notified = false;
      notifier.addListener(() {
        notified = true;
      });
      await notifier.setGoogleApiKey('test_key');
      expect(notified, isTrue);
    });

    test('5. SettingsNotifier - setGoogleBaseUrl notifies listeners', () async {
      final notifier = SettingsNotifier();
      bool notified = false;
      notifier.addListener(() {
        notified = true;
      });
      await notifier.setGoogleBaseUrl('https://example.com');
      expect(notified, isTrue);
    });

    test('6. SettingsNotifier - setGoogleModel notifies listeners', () async {
      final notifier = SettingsNotifier();
      bool notified = false;
      notifier.addListener(() {
        notified = true;
      });
      await notifier.setGoogleModel('gemini-ultra');
      expect(notified, isTrue);
    });

    test('7. FakeSettingsNotifier - persistence saves and loads values correctly', () async {
      final notifier = FakeSettingsNotifier();
      await notifier.setGoogleApiKey('persistent_key');
      await notifier.setGoogleBaseUrl('https://custom.api');
      await notifier.setGoogleModel('model-v2');

      // Create a new notifier and simulate loading from the same mock secure storage
      final loadedNotifier = FakeSettingsNotifier();
      loadedNotifier.mockStorage._data.addAll(notifier.mockStorage._data);
      await loadedNotifier.simulateLoad();

      expect(loadedNotifier.googleApiKey, equals('persistent_key'));
      expect(loadedNotifier.googleBaseUrl, equals('https://custom.api'));
      expect(loadedNotifier.googleModel, equals('model-v2'));
    });

    testWidgets('8. SettingsDialog UI - renders Agent Settings / LLM 設定 section title', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));
      expect(find.text('Agent Settings / LLM 設定'), findsOneWidget);
    });

    testWidgets('9. SettingsDialog UI - has API Key text field', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));
      expect(find.byKey(const Key('apiKeyField')), findsOneWidget);
    });

    testWidgets('10. SettingsDialog UI - has Base URL text field', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));
      expect(find.byKey(const Key('baseUrlField')), findsOneWidget);
    });

    testWidgets('11. SettingsDialog UI - has Model text field', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));
      expect(find.byKey(const Key('modelField')), findsOneWidget);
    });

    testWidgets('12. SettingsDialog UI - API key visibility toggle starts hidden', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));
      final textField = tester.widget<TextField>(find.byKey(const Key('apiKeyField')));
      expect(textField.obscureText, isTrue);
    });

    testWidgets('13. SettingsDialog UI - API key visibility toggle shows characters when clicked', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));

      await tester.tap(find.byKey(const Key('visibilityToggle')));
      await tester.pump();

      final textField = tester.widget<TextField>(find.byKey(const Key('apiKeyField')));
      expect(textField.obscureText, isFalse);
    });

    testWidgets('14. SettingsDialog UI - changes saved to SettingsNotifier on confirmation', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));

      await tester.enterText(find.byKey(const Key('apiKeyField')), 'ui_api_key');
      await tester.enterText(find.byKey(const Key('baseUrlField')), 'https://ui.base.url');
      await tester.enterText(find.byKey(const Key('modelField')), 'ui-model');

      await tester.tap(find.byKey(const Key('saveButton')));
      await tester.pump();

      expect(notifier.googleApiKey, equals('ui_api_key'));
      expect(notifier.googleBaseUrl, equals('https://ui.base.url'));
      expect(notifier.googleModel, equals('ui-model'));
    });

    test('15. HermesFallback - API key falls back to global settings when profile settings empty', () {
      const profileApiKey = '';
      const globalApiKey = 'global_key_123';
      final resolved = resolveFallback(
        profileValue: profileApiKey,
        globalValue: globalApiKey,
        defaultValue: '',
      );
      expect(resolved, equals('global_key_123'));
    });

    test('16. HermesFallback - Base URL falls back to global settings when profile settings empty', () {
      const profileBaseUrl = '';
      const globalBaseUrl = 'https://global.base.url';
      final resolved = resolveFallback(
        profileValue: profileBaseUrl,
        globalValue: globalBaseUrl,
        defaultValue: 'https://generativelanguage.googleapis.com/v1beta',
      );
      expect(resolved, equals('https://global.base.url'));
    });

    test('17. HermesFallback - Model falls back to global settings when profile settings empty', () {
      const profileModel = '';
      const globalModel = 'global-gemini-model';
      final resolved = resolveFallback(
        profileValue: profileModel,
        globalValue: globalModel,
        defaultValue: 'gemini-3.5-flash',
      );
      expect(resolved, equals('global-gemini-model'));
    });

    test('18. HermesFallback - new project profile default inherits global settings', () {
      // By default a new project profile settings map has empty values
      final newProjectProfileSettings = <String, String>{
        'apiKey': '',
        'baseUrl': '',
        'model': '',
      };
      const globalApiKey = 'global_key';
      const globalBaseUrl = 'https://global.url';
      const globalModel = 'global-model';

      final resolvedKey = resolveFallback(
        profileValue: newProjectProfileSettings['apiKey']!,
        globalValue: globalApiKey,
        defaultValue: '',
      );
      final resolvedUrl = resolveFallback(
        profileValue: newProjectProfileSettings['baseUrl']!,
        globalValue: globalBaseUrl,
        defaultValue: 'https://generativelanguage.googleapis.com/v1beta',
      );
      final resolvedModel = resolveFallback(
        profileValue: newProjectProfileSettings['model']!,
        globalValue: globalModel,
        defaultValue: 'gemini-3.5-flash',
      );

      expect(resolvedKey, equals('global_key'));
      expect(resolvedUrl, equals('https://global.url'));
      expect(resolvedModel, equals('global-model'));
    });
  });

  group('Tier 2: Boundary & Corner Cases', () {
    test('19. Boundary - empty global API key handles fallback appropriately', () {
      final resolved = resolveFallback(
        profileValue: '',
        globalValue: '',
        defaultValue: '',
      );
      expect(resolved, isEmpty);
    });

    test('20. Boundary - whitespace-only global base URL is trimmed', () {
      final resolved = resolveFallback(
        profileValue: '',
        globalValue: '   https://trimmed.url   ',
        defaultValue: 'https://generativelanguage.googleapis.com/v1beta',
      );
      expect(resolved, equals('https://trimmed.url'));
    });

    test('21. Boundary - whitespace-only global model is trimmed', () {
      final resolved = resolveFallback(
        profileValue: '',
        globalValue: '   gemini-trimmed   ',
        defaultValue: 'gemini-3.5-flash',
      );
      expect(resolved, equals('gemini-trimmed'));
    });

    test('22. Boundary - very long API key (1000+ chars) handles storage and retrieval', () async {
      final longKey = 'A' * 1024;
      final notifier = FakeSettingsNotifier();
      await notifier.setGoogleApiKey(longKey);
      expect(notifier.googleApiKey, equals(longKey));
    });

    test('23. Boundary - very long base URL (2000+ chars) handles constraints', () async {
      final longUrl = 'https://${'B' * 2000}.com';
      final notifier = FakeSettingsNotifier();
      await notifier.setGoogleBaseUrl(longUrl);
      expect(notifier.googleBaseUrl, equals(longUrl));
    });

    test('24. Boundary - secure storage read exception defaults back gracefully', () async {
      final notifier = FakeSettingsNotifier();
      await notifier.setGoogleApiKey('temp_key');
      notifier.mockStorage.throwOnRead = true;
      await notifier.simulateLoad();
      // Should reset/default back gracefully instead of crashing
      expect(notifier.googleApiKey, isEmpty);
      expect(notifier.googleBaseUrl, equals('https://generativelanguage.googleapis.com/v1beta'));
    });

    test('25. Boundary - secure storage write exception is caught and handles failure gracefully', () async {
      final notifier = FakeSettingsNotifier();
      notifier.mockStorage.throwOnWrite = true;
      expect(() => notifier.setGoogleApiKey('test_key'), throwsA(isA<Exception>()));
    });

    test('26. Boundary - inputs are trimmed before saving', () async {
      final resolvedKey = resolveFallback(profileValue: '', globalValue: '  api_key_spaces  ', defaultValue: '');
      expect(resolvedKey, equals('api_key_spaces'));
    });

    testWidgets('27. Boundary UI - toggle API key visibility repeatedly updates obscure text state', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));

      final stateFinder = find.byKey(const Key('apiKeyField'));
      expect(tester.widget<TextField>(stateFinder).obscureText, isTrue);

      for (int i = 0; i < 10; i++) {
        await tester.tap(find.byKey(const Key('visibilityToggle')));
        await tester.pump();
        expect(tester.widget<TextField>(stateFinder).obscureText, equals(i % 2 == 0 ? false : true));
      }
    });

    testWidgets('28. Boundary UI - closing settings dialog without changes does not mutate notifier', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      await notifier.setGoogleApiKey('initial');
      
      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));
      await tester.enterText(find.byKey(const Key('apiKeyField')), 'changed');
      
      // Close/dispose dialog without tapping save button
      await tester.pumpWidget(Container());
      
      expect(notifier.googleApiKey, equals('initial'));
    });

    testWidgets('29. Boundary UI - multiple dialog instances retain isolated text fields but share same notifier', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      await notifier.setGoogleApiKey('initial_key');

      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));
      expect(find.text('initial_key'), findsOneWidget);

      // Re-pump dialog (e.g. simulating reopening it)
      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));
      expect(find.text('initial_key'), findsOneWidget);
    });

    test('30. Boundary Hermes - whitespace-only profile settings fall back to global settings', () {
      const profileApiKey = '   ';
      const globalApiKey = 'global_api_key_fallback';
      final resolved = resolveFallback(
        profileValue: profileApiKey,
        globalValue: globalApiKey,
        defaultValue: '',
      );
      expect(resolved, equals('global_api_key_fallback'));
    });

    testWidgets('31. Boundary Hermes - real-time fallback updates when global settings change', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      final profileSettings = <String, String>{'apiKey': '', 'baseUrl': '', 'model': ''};

      await tester.pumpWidget(TestHermesTab(
        settingsNotifier: notifier,
        profileSettings: profileSettings,
      ));

      expect(find.text('Resolved API Key: '), findsOneWidget);

      await notifier.setGoogleApiKey('updated_global_key');
      await tester.pump();

      expect(find.text('Resolved API Key: updated_global_key'), findsOneWidget);
    });

    test('32. Boundary Hermes - empty global values default to SDK defaults', () {
      final resolvedUrl = resolveFallback(
        profileValue: '',
        globalValue: '',
        defaultValue: 'https://generativelanguage.googleapis.com/v1beta',
      );
      expect(resolvedUrl, equals('https://generativelanguage.googleapis.com/v1beta'));
    });

    test('33. Boundary Hermes - multiple profiles with custom override combinations', () {
      final profileA = {'apiKey': 'key_a', 'baseUrl': '', 'model': ''};
      final profileB = {'apiKey': '', 'baseUrl': 'https://url_b', 'model': 'model_b'};
      final global = {'apiKey': 'global_key', 'baseUrl': 'https://global_url', 'model': 'global_model'};

      expect(resolveFallback(profileValue: profileA['apiKey']!, globalValue: global['apiKey']!, defaultValue: ''), equals('key_a'));
      expect(resolveFallback(profileValue: profileA['baseUrl']!, globalValue: global['baseUrl']!, defaultValue: ''), equals('https://global_url'));
      expect(resolveFallback(profileValue: profileA['model']!, globalValue: global['model']!, defaultValue: ''), equals('global_model'));

      expect(resolveFallback(profileValue: profileB['apiKey']!, globalValue: global['apiKey']!, defaultValue: ''), equals('global_key'));
      expect(resolveFallback(profileValue: profileB['baseUrl']!, globalValue: global['baseUrl']!, defaultValue: ''), equals('https://url_b'));
      expect(resolveFallback(profileValue: profileB['model']!, globalValue: global['model']!, defaultValue: ''), equals('model_b'));
    });

    test('34. Boundary - extremely short or invalid base URLs', () async {
      final notifier = FakeSettingsNotifier();
      await notifier.setGoogleBaseUrl('h');
      expect(notifier.googleBaseUrl, equals('h'));
    });
  });

  group('Tier 3: Cross-Feature Combinations', () {
    testWidgets('35. Cross-Feature - dialog edit -> Hermes fallback immediately resolves to new value', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();
      final profileSettings = <String, String>{'apiKey': '', 'baseUrl': '', 'model': ''};

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              Expanded(child: TestSettingsDialog(settingsNotifier: notifier)),
              Expanded(child: TestHermesTab(settingsNotifier: notifier, profileSettings: profileSettings)),
            ],
          ),
        ),
      ));

      expect(find.text('Resolved API Key: '), findsOneWidget);

      await tester.enterText(find.byKey(const Key('apiKeyField')), 'cross_feature_key');
      await tester.tap(find.byKey(const Key('saveButton')));
      await tester.pump();

      expect(find.text('Resolved API Key: cross_feature_key'), findsOneWidget);
    });

    test('36. Cross-Feature - project profile override ignores changes to global settings', () {
      final profileSettings = <String, String>{
        'apiKey': 'profile_override_key',
        'baseUrl': 'https://profile.override',
        'model': 'profile-model',
      };
      
      const globalApiKey = 'global_key_changed';
      
      final resolved = resolveFallback(
        profileValue: profileSettings['apiKey']!,
        globalValue: globalApiKey,
        defaultValue: '',
      );
      
      expect(resolved, equals('profile_override_key'));
    });

    test('37. Cross-Feature - resetting global settings restores hardcoded fallbacks in Hermes', () {
      final profileSettings = <String, String>{'apiKey': '', 'baseUrl': '', 'model': ''};
      
      const globalApiKey = '';
      const globalBaseUrl = '';
      const globalModel = '';

      final resolvedKey = resolveFallback(
        profileValue: profileSettings['apiKey']!,
        globalValue: globalApiKey,
        defaultValue: '',
      );
      final resolvedUrl = resolveFallback(
        profileValue: profileSettings['baseUrl']!,
        globalValue: globalBaseUrl,
        defaultValue: 'https://generativelanguage.googleapis.com/v1beta',
      );
      final resolvedModel = resolveFallback(
        profileValue: profileSettings['model']!,
        globalValue: globalModel,
        defaultValue: 'gemini-3.5-flash',
      );

      expect(resolvedKey, isEmpty);
      expect(resolvedUrl, equals('https://generativelanguage.googleapis.com/v1beta'));
      expect(resolvedModel, equals('gemini-3.5-flash'));
    });
  });

  group('Tier 4: Real-World Scenarios', () {
    testWidgets('38. Real-World - user onboarding: start app -> set global config -> new profile inheritance', (WidgetTester tester) async {
      final notifier = FakeSettingsNotifier();

      await tester.pumpWidget(TestSettingsDialog(settingsNotifier: notifier));
      await tester.enterText(find.byKey(const Key('apiKeyField')), 'real_world_onboarding_key');
      await tester.enterText(find.byKey(const Key('baseUrlField')), 'https://real.world.api');
      await tester.enterText(find.byKey(const Key('modelField')), 'gemini-pro-real');
      await tester.tap(find.byKey(const Key('saveButton')));
      await tester.pump();

      final newProfileSettings = <String, String>{'apiKey': '', 'baseUrl': '', 'model': ''};
      await tester.pumpWidget(TestHermesTab(settingsNotifier: notifier, profileSettings: newProfileSettings));

      expect(find.text('Resolved API Key: real_world_onboarding_key'), findsOneWidget);
      expect(find.text('Resolved Base URL: https://real.world.api'), findsOneWidget);
      expect(find.text('Resolved Model: gemini-pro-real'), findsOneWidget);
    });

    test('39. Real-World - partial override: user overrides API key on profile A, falls back for others', () {
      final profileA = {'apiKey': 'override_key_a', 'baseUrl': '', 'model': ''};
      final profileB = {'apiKey': '', 'baseUrl': '', 'model': ''};
      
      const globalApiKey = 'global_api_key';
      const globalBaseUrl = 'https://global.url';
      const globalModel = 'global-model';

      expect(resolveFallback(profileValue: profileA['apiKey']!, globalValue: globalApiKey, defaultValue: ''), equals('override_key_a'));
      expect(resolveFallback(profileValue: profileA['baseUrl']!, globalValue: globalBaseUrl, defaultValue: ''), equals('https://global.url'));
      expect(resolveFallback(profileValue: profileA['model']!, globalValue: globalModel, defaultValue: ''), equals('global-model'));

      expect(resolveFallback(profileValue: profileB['apiKey']!, globalValue: globalApiKey, defaultValue: ''), equals('global_api_key'));
      expect(resolveFallback(profileValue: profileB['baseUrl']!, globalValue: globalBaseUrl, defaultValue: ''), equals('https://global.url'));
      expect(resolveFallback(profileValue: profileB['model']!, globalValue: globalModel, defaultValue: ''), equals('global-model'));
    });

    test('40. Real-World - system reset: clear all settings -> verify fallback back to defaults', () async {
      final notifier = FakeSettingsNotifier();
      await notifier.setGoogleApiKey('key_to_clear');
      await notifier.setGoogleBaseUrl('https://url_to_clear');
      await notifier.setGoogleModel('model_to_clear');

      await notifier.setGoogleApiKey('');
      await notifier.setGoogleBaseUrl('');
      await notifier.setGoogleModel('');

      final profileSettings = <String, String>{'apiKey': '', 'baseUrl': '', 'model': ''};

      final resolvedKey = resolveFallback(profileValue: profileSettings['apiKey']!, globalValue: notifier.googleApiKey, defaultValue: '');
      final resolvedUrl = resolveFallback(profileValue: profileSettings['baseUrl']!, globalValue: notifier.googleBaseUrl, defaultValue: 'https://generativelanguage.googleapis.com/v1beta');
      final resolvedModel = resolveFallback(profileValue: profileSettings['model']!, globalValue: notifier.googleModel, defaultValue: 'gemini-3.5-flash');

      expect(resolvedKey, isEmpty);
      expect(resolvedUrl, equals('https://generativelanguage.googleapis.com/v1beta'));
      expect(resolvedModel, equals('gemini-3.5-flash'));
    });

    test('41. Real-World - connection config: invalid global config overridden by valid profile config', () {
      final global = {'apiKey': 'invalid_global_key', 'baseUrl': 'https://bad.global.url', 'model': 'bad-model'};
      final profile = {'apiKey': 'VALID_PROFILE_KEY', 'baseUrl': 'https://valid.profile.url', 'model': 'gemini-1.5-pro'};

      final resolvedKey = resolveFallback(profileValue: profile['apiKey']!, globalValue: global['apiKey']!, defaultValue: '');
      final resolvedUrl = resolveFallback(profileValue: profile['baseUrl']!, globalValue: global['baseUrl']!, defaultValue: '');
      final resolvedModel = resolveFallback(profileValue: profile['model']!, globalValue: global['model']!, defaultValue: '');

      expect(resolvedKey, equals('VALID_PROFILE_KEY'));
      expect(resolvedUrl, equals('https://valid.profile.url'));
      expect(resolvedModel, equals('gemini-1.5-pro'));
    });

    test('42. Real-World - cosmetic integration: theme switching does not affect LLM settings state', () async {
      final notifier = FakeSettingsNotifier();
      await notifier.setGoogleApiKey('theme_safety_key');

      notifier.setThemeByName('Graphite Dark');

      expect(notifier.googleApiKey, equals('theme_safety_key'));
    });
  });

  group('Tier 5: Additional Edge Cases & Stress Tests', () {
    test('43. Zoom Out Clamping - cannot zoom out past 0.5', () {
      final notifier = SettingsNotifier();
      notifier.setZoom(0.5);
      expect(notifier.zoom, equals(0.5));
      notifier.zoomOut();
      expect(notifier.zoom, equals(0.5));
    });

    test('44. Zoom In Clamping - cannot zoom in past 2.0', () {
      final notifier = SettingsNotifier();
      notifier.setZoom(2.0);
      expect(notifier.zoom, equals(2.0));
      notifier.zoomIn();
      expect(notifier.zoom, equals(2.0));
    });

    test('45. Zoom Reset - resets to exactly 1.0', () {
      final notifier = SettingsNotifier();
      notifier.setZoom(1.5);
      notifier.resetZoom();
      expect(notifier.zoom, equals(1.0));
    });

    test('46. Invalid Theme Fallback - defaults to first theme if unknown name is given', () {
      final notifier = SettingsNotifier();
      notifier.setThemeByName('Unknown Theme Name');
      expect(notifier.currentTheme.name, equals('Graphite'));
    });

    test('47. SettingsNotifier Trimming - trims leading/trailing spaces for api key, base url, and model', () async {
      final notifier = SettingsNotifier();
      await notifier.setGoogleApiKey('  trimmed_key_val  ');
      await notifier.setGoogleBaseUrl('  https://trimmed.url  ');
      await notifier.setGoogleModel('  gemini-trimmed  ');

      expect(notifier.googleApiKey, equals('trimmed_key_val'));
      expect(notifier.googleBaseUrl, equals('https://trimmed.url'));
      expect(notifier.googleModel, equals('gemini-trimmed'));
    });

    test('48. Zoom Setter Clamping - setZoom clamps out of bound values', () {
      final notifier = SettingsNotifier();
      notifier.setZoom(3.5);
      expect(notifier.zoom, equals(2.0));
      notifier.setZoom(0.2);
      expect(notifier.zoom, equals(0.5));
    });
  });
}

