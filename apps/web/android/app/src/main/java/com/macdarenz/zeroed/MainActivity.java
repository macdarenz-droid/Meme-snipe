package com.macdarenz.zeroed;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);

        // Back closes an open sheet first (the web layer keeps one history entry per sheet),
        // then goes back a screen, then leaves the app.
        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    WebView web = getBridge().getWebView();
                    if (web.canGoBack()) {
                        web.goBack();
                    } else {
                        finish();
                    }
                }
            }
        );
    }
}
