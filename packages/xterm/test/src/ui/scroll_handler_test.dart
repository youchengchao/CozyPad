import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
import 'package:xterm/src/ui/scroll_handler.dart';
import 'package:xterm/src/ui/infinite_scroll_view.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('TerminalScrollGestureHandler Scroll Behavior', () {
    late Terminal terminal;
    late List<String> terminalOutput;

    setUp(() {
      terminalOutput = <String>[];
      terminal = Terminal(
        onOutput: (data) {
          terminalOutput.add(data);
        },
      );
    });

    Widget buildTestWidget({
      required bool simulateScroll,
      double Function()? getLineHeight,
      CellOffset Function(Offset)? getCellOffset,
    }) {
      return MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 800,
            height: 600,
            child: TerminalScrollGestureHandler(
              terminal: terminal,
              simulateScroll: simulateScroll,
              getCellOffset: getCellOffset ?? (offset) => CellOffset(0, 0),
              getLineHeight: getLineHeight ?? () => 15.0,
              child: const SizedBox.expand(
                child: Text('Terminal Content Placeholder'),
              ),
            ),
          ),
        ),
      );
    }

    testWidgets('Mode 6: State persistence check with print debug', (tester) async {
      terminal.useAltBuffer();
      await tester.pumpWidget(buildTestWidget(simulateScroll: true));

      // Find the State
      final dynamic state = tester.state(find.byType(TerminalScrollGestureHandler));
      print('Initial state.lastLineOffset: ${state.lastLineOffset}');

      // Scroll down by 150 pixels (10 lines)
      await tester.drag(find.byType(TerminalScrollGestureHandler), const Offset(0, -150));
      await tester.pumpAndSettle();

      print('State.lastLineOffset after 1st scroll: ${state.lastLineOffset}');
      expect(terminalOutput.length, 10);
      terminalOutput.clear();

      // Disable alt buffer
      terminal.useMainBuffer();
      await tester.pumpWidget(buildTestWidget(simulateScroll: true));
      await tester.pumpAndSettle();

      print('State.lastLineOffset while disabled: ${state.lastLineOffset}');

      // Enable alt buffer again
      terminal.useAltBuffer();
      await tester.pumpWidget(buildTestWidget(simulateScroll: true));
      await tester.pumpAndSettle();

      // Find the state again (to check if it is the same instance or a new one)
      final dynamic state2 = tester.state(find.byType(TerminalScrollGestureHandler));
      print('State instance identical: ${identical(state, state2)}');
      print('State2.lastLineOffset before 2nd scroll: ${state2.lastLineOffset}');

      // Scroll down by 15 pixels (1 line)
      await tester.drag(find.byType(TerminalScrollGestureHandler), const Offset(0, -15));
      await tester.pumpAndSettle();

      print('State2.lastLineOffset after 2nd scroll: ${state2.lastLineOffset}');
      print('Terminal output count: ${terminalOutput.length}');
      print('Terminal output content: $terminalOutput');
    });

    testWidgets('lastLineOffset is reset to 0 when _shouldInterceptScroll transitions to true', (tester) async {
      terminal.write('\x1b[?1049h'); // Enable alt buffer
      await tester.pumpWidget(buildTestWidget(simulateScroll: true));
      await tester.pumpAndSettle();

      final dynamic state = tester.state(find.byType(TerminalScrollGestureHandler));
      expect(state.shouldInterceptScroll, isTrue);

      // Scroll down by 150 pixels (10 lines)
      await tester.drag(find.byType(TerminalScrollGestureHandler), const Offset(0, -150));
      await tester.pumpAndSettle();
      expect(state.lastLineOffset, 10);

      // Disable alt buffer via escape sequence to trigger notifyListeners
      terminal.write('\x1b[?1049l');
      await tester.pumpAndSettle();
      expect(state.shouldInterceptScroll, isFalse);

      // Enable alt buffer again
      terminal.write('\x1b[?1049h');
      await tester.pumpAndSettle();
      expect(state.shouldInterceptScroll, isTrue);
      
      // lastLineOffset must be reset to 0
      expect(state.lastLineOffset, 0);
    });

    testWidgets('lastLineOffset is reset to 0 when terminal instance changes', (tester) async {
      terminal.write('\x1b[?1049h'); // Enable alt buffer
      await tester.pumpWidget(buildTestWidget(simulateScroll: true));
      await tester.pumpAndSettle();

      final dynamic state1 = tester.state(find.byType(TerminalScrollGestureHandler));
      expect(state1.shouldInterceptScroll, isTrue);

      // Scroll down by 150 pixels (10 lines)
      await tester.drag(find.byType(TerminalScrollGestureHandler), const Offset(0, -150));
      await tester.pumpAndSettle();
      expect(state1.lastLineOffset, 10);

      // Rebuild widget with a new Terminal instance (both using alt buffer)
      final newTerminal = Terminal()..write('\x1b[?1049h');
      
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 800,
            height: 600,
            child: TerminalScrollGestureHandler(
              terminal: newTerminal,
              simulateScroll: true,
              getCellOffset: (offset) => CellOffset(0, 0),
              getLineHeight: () => 15.0,
              child: const SizedBox.expand(
                child: Text('Terminal Content Placeholder'),
              ),
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();

      final dynamic state2 = tester.state(find.byType(TerminalScrollGestureHandler));
      // Even if state instance is reused (due to same position in the element tree),
      // lastLineOffset must be reset to 0 when the terminal instance updates.
      expect(state2.lastLineOffset, 0);
    });

    testWidgets('getLineHeight <= 0 safety: returns early for 0 and negative heights', (tester) async {
      terminal.write('\x1b[?1049h');
      
      double mockLineHeight = 15.0;

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 800,
            height: 600,
            child: TerminalScrollGestureHandler(
              terminal: terminal,
              simulateScroll: true,
              getCellOffset: (offset) => CellOffset(0, 0),
              getLineHeight: () => mockLineHeight,
              child: const SizedBox.expand(
                child: Text('Terminal Content Placeholder'),
              ),
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();

      final dynamic state = tester.state(find.byType(TerminalScrollGestureHandler));

      // Scroll with positive height
      await tester.drag(find.byType(TerminalScrollGestureHandler), const Offset(0, -30));
      await tester.pumpAndSettle();
      expect(state.lastLineOffset, 2);
      expect(terminalOutput.length, 2);
      terminalOutput.clear();

      // Now set mockLineHeight to 0.0
      mockLineHeight = 0.0;
      await tester.drag(find.byType(TerminalScrollGestureHandler), const Offset(0, -30));
      await tester.pumpAndSettle();
      
      // Scroll output should be 0 because it returned early
      expect(terminalOutput.length, 0);
      expect(state.lastLineOffset, 2); // unchanged

      // Now set mockLineHeight to negative
      mockLineHeight = -5.0;
      await tester.drag(find.byType(TerminalScrollGestureHandler), const Offset(0, -30));
      await tester.pumpAndSettle();
      expect(terminalOutput.length, 0);
      expect(state.lastLineOffset, 2); // unchanged
    });

    testWidgets('getLineHeight NaN and Infinity safety', (tester) async {
      terminal.write('\x1b[?1049h');
      double mockLineHeight = double.nan;

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 800,
            height: 600,
            child: TerminalScrollGestureHandler(
              terminal: terminal,
              simulateScroll: true,
              getCellOffset: (offset) => CellOffset(0, 0),
              getLineHeight: () => mockLineHeight,
              child: const SizedBox.expand(
                child: Text('Terminal Content Placeholder'),
              ),
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();

      // Dragging with NaN line height.
      await tester.drag(find.byType(TerminalScrollGestureHandler), const Offset(0, -30));
      await tester.pumpAndSettle();

      // Dragging with Infinity line height.
      mockLineHeight = double.infinity;
      await tester.drag(find.byType(TerminalScrollGestureHandler), const Offset(0, -30));
      await tester.pumpAndSettle();
    });

    testWidgets('getLineHeight micro-values safety (stress test for division hang)', (tester) async {
      terminal.write('\x1b[?1049h');
      double mockLineHeight = 1e-9; // micro height

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 800,
            height: 600,
            child: TerminalScrollGestureHandler(
              terminal: terminal,
              simulateScroll: true,
              getCellOffset: (offset) => CellOffset(0, 0),
              getLineHeight: () => mockLineHeight,
              child: const SizedBox.expand(
                child: Text('Terminal Content Placeholder'),
              ),
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();

      // A small scroll offset over micro line height results in ~10,000 iterations.
      await tester.drag(find.byType(TerminalScrollGestureHandler), const Offset(0, -0.00001));
      await tester.pumpAndSettle();
    });

    testWidgets('onPointerMove drag coordinates tracking', (tester) async {
      terminal.write('\x1b[?1049h');
      
      List<Offset> capturedOffsets = [];

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 800,
            height: 600,
            child: TerminalScrollGestureHandler(
              terminal: terminal,
              simulateScroll: true,
              getCellOffset: (offset) {
                capturedOffsets.add(offset);
                return CellOffset(0, 0);
              },
              getLineHeight: () => 15.0,
              child: const SizedBox.expand(
                child: Text('Terminal Content Placeholder'),
              ),
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();

      // Start drag at (100, 100) and drag to (100, 50)
      final gesture = await tester.startGesture(const Offset(100, 100));
      await tester.pump();
      await gesture.moveBy(const Offset(0, -50));
      await tester.pump();
      await gesture.up();
      await tester.pumpAndSettle();

      // The pointer positions should be recorded.
      expect(capturedOffsets, isNotEmpty);
      // The offsets should match the gesture path.
      expect(capturedOffsets.any((o) => o.dy >= 50 && o.dy <= 100), isTrue);
    });

    testWidgets('getLineHeight safety: NaN returns early without error', (tester) async {
      terminal.useAltBuffer();
      await tester.pumpWidget(buildTestWidget(
        simulateScroll: true,
        getLineHeight: () => double.nan,
      ));
      await tester.pumpAndSettle();

      final scrollable = tester.state<ScrollableState>(find.byType(Scrollable));
      scrollable.position.jumpTo(15.0);
      
      final dynamic exception = tester.takeException();
      expect(exception, isNull);
      expect(terminalOutput, isEmpty);
    });

    testWidgets('getLineHeight safety: zero or negative returns early without error', (tester) async {
      terminal.useAltBuffer();
      
      // Zero height
      await tester.pumpWidget(buildTestWidget(
        simulateScroll: true,
        getLineHeight: () => 0.0,
      ));
      await tester.pumpAndSettle();
      var scrollable = tester.state<ScrollableState>(find.byType(Scrollable));
      scrollable.position.jumpTo(15.0);
      expect(tester.takeException(), isNull);
      expect(terminalOutput, isEmpty);

      // Negative height
      await tester.pumpWidget(buildTestWidget(
        simulateScroll: true,
        getLineHeight: () => -10.0,
      ));
      await tester.pumpAndSettle();
      scrollable = tester.state<ScrollableState>(find.byType(Scrollable));
      scrollable.position.jumpTo(15.0);
      expect(tester.takeException(), isNull);
      expect(terminalOutput, isEmpty);
    });

    testWidgets('getLineHeight safety stress: tiny positive height (>0.1) does not crash but generates many events', (tester) async {
      terminal.useAltBuffer();
      
      await tester.pumpWidget(buildTestWidget(
        simulateScroll: true,
        getLineHeight: () => 0.2,
      ));
      await tester.pumpAndSettle();
      
      final scrollable = tester.state<ScrollableState>(find.byType(Scrollable));
      scrollable.position.jumpTo(200.0); // 200.0 ~/ 0.2 = 1000 lines
      await tester.pumpAndSettle();
      
      expect(tester.takeException(), isNull);
      expect(terminalOutput.length, 1000);
    });

    testWidgets('lastLineOffset transition logic and negative scroll dead zone verification', (tester) async {
      terminal.useAltBuffer();
      await tester.pumpWidget(buildTestWidget(simulateScroll: true));
      await tester.pumpAndSettle();

      final scrollable = tester.state<ScrollableState>(find.byType(Scrollable));

      // 1. Initial state is 0. Jump to 14.9.
      // currentLineOffset = 14.9 ~/ 15.0 = 0. No scroll event.
      scrollable.position.jumpTo(14.9);
      await tester.pumpAndSettle();
      expect(terminalOutput, isEmpty);

      // 2. Jump to 15.0.
      // currentLineOffset = 15.0 ~/ 15.0 = 1. Fires 1 scroll event.
      scrollable.position.jumpTo(15.0);
      await tester.pumpAndSettle();
      expect(terminalOutput.length, 1);
      terminalOutput.clear();

      // 3. Jump to -14.9.
      // currentLineOffset = -14.9 ~/ 15.0 = 0.
      // Delta = 0 - 1 = -1. Fires 1 scroll event (up).
      scrollable.position.jumpTo(-14.9);
      await tester.pumpAndSettle();
      expect(terminalOutput.length, 1);
      terminalOutput.clear();

      // 4. Jump to -15.0.
      // currentLineOffset = -15.0 ~/ 15.0 = -1.
      // Delta = -1 - 0 = -1. Fires 1 scroll event (up).
      scrollable.position.jumpTo(-15.0);
      await tester.pumpAndSettle();
      expect(terminalOutput.length, 1);
      terminalOutput.clear();

      // 5. Demonstrate the dead zone: jump from -14.0 to 14.0.
      // At -14.0: currentLineOffset = -14.0 ~/ 15 = 0.
      // Jump to -14.0:
      scrollable.position.jumpTo(-14.0);
      await tester.pumpAndSettle();
      terminalOutput.clear();

      // Jump to 14.0:
      scrollable.position.jumpTo(14.0);
      await tester.pumpAndSettle();
      // Moving 28 pixels (nearly 2 lines) across 0 boundary results in 0 scroll events
      // because currentLineOffset goes from 0 (-14.0 ~/ 15.0) to 0 (14.0 ~/ 15.0).
      expect(terminalOutput, isEmpty);
    });

    testWidgets('onPointerMove multi-touch drag coordinates tracking check', (tester) async {
      terminal.useAltBuffer();

      Offset? capturedOffset;
      await tester.pumpWidget(buildTestWidget(
        simulateScroll: true,
        getCellOffset: (offset) {
          capturedOffset = offset;
          return CellOffset(0, 0);
        },
      ));
      await tester.pumpAndSettle();

      // Start drag with pointer 1 (active scroll driver)
      final gesture1 = await tester.startGesture(const Offset(100, 300), pointer: 1);
      await tester.pumpAndSettle();

      final scrollable = tester.state<ScrollableState>(find.byType(Scrollable));

      // Programmatically scroll to 15.0
      scrollable.position.jumpTo(15.0);
      await tester.pumpAndSettle();
      
      // It should have triggered a scroll event and captured pointer 1's position
      expect(capturedOffset, const Offset(100, 300));
      capturedOffset = null;

      // Start gesture 2 with pointer 2 (simulating another finger touch down)
      final gesture2 = await tester.startGesture(const Offset(300, 300), pointer: 2);
      await tester.pumpAndSettle();

      // Programmatically scroll to 30.0
      scrollable.position.jumpTo(30.0);
      await tester.pumpAndSettle();

      // Because gesture 2 touched down at (300, 300), the lastPointerPosition
      // gets overwritten by pointer 2, even though pointer 1 is still down and was the original scroll initiator.
      expect(capturedOffset, const Offset(300, 300));

      await gesture1.up();
      await gesture2.up();
    });

    testWidgets('offset NaN and Infinity safety', (tester) async {
      terminal.useAltBuffer();
      await tester.pumpWidget(buildTestWidget(simulateScroll: true));
      await tester.pumpAndSettle();

      final dynamic state = tester.state(find.byType(TerminalScrollGestureHandler));
      print('DEBUG: isUsingAltBuffer: ${terminal.isUsingAltBuffer}');
      print('DEBUG: shouldInterceptScroll: ${state.shouldInterceptScroll}');

      final scrollview = tester.widget<InfiniteScrollView>(find.byType(InfiniteScrollView));

      // Call onScroll programmatically with double.nan
      try {
        scrollview.onScroll(double.nan);
      } catch (e) {
        print('Captured exception for NaN offset: $e');
      }

      // Call onScroll programmatically with double.infinity
      try {
        scrollview.onScroll(double.infinity);
      } catch (e) {
        print('Captured exception for Infinity offset: $e');
      }
    });

    testWidgets('stress test: massive offset loop check', (tester) async {
      terminal.useAltBuffer();
      await tester.pumpWidget(buildTestWidget(
        simulateScroll: true,
        getLineHeight: () => 0.11, // just above the 0.1 threshold
      ));
      await tester.pumpAndSettle();

      final scrollview = tester.widget<InfiniteScrollView>(find.byType(InfiniteScrollView));

      // Scroll offset of 10,000 pixels at 0.11 height would result in ~90,909 iterations.
      // Let's call it and measure time or ensure it executes.
      final stopwatch = Stopwatch()..start();
      scrollview.onScroll(10000.0);
      stopwatch.stop();
      print('Massive offset scroll loop elapsed: ${stopwatch.elapsedMilliseconds} ms');
    });
  });
}
