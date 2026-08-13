package com.cozypad.app

/**
 * Serializes ownership of asynchronous SSH connection attempts.
 *
 * A superseded attempt may still finish later, but it must not publish state or
 * mutate the client owned by the newest attempt.
 */
internal class SshConnectAttemptGate {
    private var currentId = 0

    @Synchronized
    fun begin(): Int {
        currentId += 1
        return currentId
    }

    @Synchronized
    fun invalidate() {
        currentId += 1
    }

    @Synchronized
    fun isCurrent(attemptId: Int): Boolean = attemptId == currentId

    @Synchronized
    fun runIfCurrent(attemptId: Int, action: () -> Unit): Boolean {
        if (attemptId != currentId) return false
        action()
        return true
    }
}
