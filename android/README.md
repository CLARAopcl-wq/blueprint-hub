# Blueprint Hub Operations — Android TWA

## What This Is
A Trusted Web Activity (TWA) that wraps blueprinthub.llc into a real Android app for Google Play.

## To Build the APK/AAB

### Requirements
- Android Studio (free from developer.android.com)
- Java JDK 17+

### Steps
1. Open Android Studio → Open this folder
2. File → Sync Project with Gradle Files
3. Build → Generate Signed Bundle/APK → Android App Bundle (AAB)
4. Create a keystore when prompted (save the password!)
5. Upload the .aab file to Google Play Console

### Digital Asset Links (Required)
Add this file to blueprinthub.llc at:
`https://blueprinthub.llc/.well-known/assetlinks.json`

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "llc.blueprinthub.app",
    "sha256_cert_fingerprints": ["YOUR_KEYSTORE_SHA256_HERE"]
  }
}]
```

(Replace YOUR_KEYSTORE_SHA256_HERE with the SHA256 from your keystore)

### App Details
- Package ID: llc.blueprinthub.app  
- Launch URL: https://blueprinthub.llc/app.html
- Min Android: 5.0 (API 21)
- Target: Android 14 (API 34)
