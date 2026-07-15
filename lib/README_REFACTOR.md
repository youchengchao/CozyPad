# SSH Dashboard lib drop-in package

This package is intended to be extracted directly inside your Flutter project's `lib/` directory.

## What changed in this build

- Refreshed the visual direction to a Linear-inspired dark developer dashboard.
- Reduced the previous cyber/glass color treatment.
- Reworked the palette toward graphite surfaces, subtle borders, restrained accents, and compact desktop UI density.
- Preserved the previous GPU backend fix: GPU process metadata is collected with batch `ps -eo pid,user,etimes,args` instead of per-PID SSH calls.
- Kept the `MyApp` compatibility fix for the default Flutter widget test.

## Files included

The zip root contains:

```text
hermes/
models/
pages/
providers/
tabs/
widgets/
main.dart
README_REFACTOR.md
REFACTOR_MANIFEST.txt
```

## Usage

1. Back up your current `lib/` directory.
2. Put this zip inside your project `lib/` directory.
3. Extract and overwrite.
4. From the project root, run:

```bash
flutter clean
flutter pub get
flutter analyze
flutter run -d windows
```

This environment did not have Flutter installed, so the package was prepared conservatively but not compiled here.
