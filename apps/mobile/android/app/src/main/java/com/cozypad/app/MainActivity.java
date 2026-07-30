package com.cozypad.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 原生 SSH 與加密儲存：WebView 沒有 raw TCP 與 Keystore 存取，由這兩個 plugin 提供。
        registerPlugin(SshPlugin.class);
        registerPlugin(SecureStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
