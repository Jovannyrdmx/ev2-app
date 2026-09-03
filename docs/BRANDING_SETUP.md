# EV2 Clandestinoz - Branding Assets Setup Guide

## Directory Structure

```
project/
├── assets/
│   ├── logos/
│   │   ├── ev2-logo-full.png          # 1024x1024 - Full EV2 logo
│   │   ├── ev2-logo-icon.png          # 512x512 - Icon only
│   │   ├── ev2-logo-text.png          # 1024x256 - Text logo
│   │   ├── ev2-mascot-nacho.png       # 1024x1024 - Colorful axolotl
│   │   └── ev2-favicon.svg            # Favicon
│   ├── backgrounds/
│   │   ├── hero-bg.jpg                # Login hero background
│   │   ├── neon-pattern.svg           # Repeating neon pattern
│   │   └── gradient-dark.svg          # Dark gradient overlay
│   ├── colors.json                     # Color palette reference
│   └── brand-guidelines.md             # Brand guidelines
├── public/
│   └── assets/ → symlink to assets/
├── imagine_images/
│   └── (existing files)
└── docker-compose.yml
```

## Color Palette (CSS Variables)

```css
:root {
    --ev2-cyan: #00BFFF;      /* Primary - Neon Cyan */
    --ev2-pink: #FF1493;      /* Secondary - Hot Pink */
    --ev2-purple: #9D00FF;    /* Accent - Vibrant Purple */
    --ev2-lime: #00FF00;      /* Tertiary - Neon Lime */
    --ev2-gold: #FFD700;      /* Tertiary - Bright Gold */
    --ev2-dark-bg: #0a0a14;   /* Background - Deep Black */
    --ev2-dark-bg-2: #1a0033; /* Background Variant */
}
```

## Logo Files to Download

Save your EV2 logos to:

```bash
# Web app
cp your-logos/ev2-logo-full.png ./public/assets/logos/
cp your-logos/ev2-mascot-nacho.png ./public/assets/logos/

# iOS
# Add to Xcode: Assets.xcassets/
# - Logo 1x, 2x, 3x (iPhone)
# - Logo 20x20, 40x40, 60x60 (App icon)

# Android
# Add to res/drawable/:
# - ic_ev2_logo.png (sizes: mdpi, hdpi, xhdpi, xxhdpi, xxxhdpi)
# - ic_ev2_mascot.png (same sizes)
```

## Web App Integration

### Step 1: Add to Dockerfile

```dockerfile
# In Dockerfile, after COPY index.html:
COPY public/assets ./public/assets
```

### Step 2: Update docker-compose.yml

```yaml
easy-flirt-web:
  volumes:
    - ./public/assets:/app/public/assets:ro
    - ./imagine_images:/app/imagine_images:ro
```

### Step 3: Use in HTML

```html
<!-- Logo in header -->
<img src="/assets/logos/ev2-logo-icon.png" alt="EV2" class="w-12 h-12">

<!-- Full logo on login -->
<img src="/assets/logos/ev2-logo-full.png" alt="EV2 Clandestinoz" class="w-48 h-48">

<!-- Mascot -->
<img src="/assets/logos/ev2-mascot-nacho.png" alt="Nacho Mascot" class="w-full max-w-sm">
```

## iOS Setup

1. **App Icon**
   - Open `Xcode → Select Project → App Icon Settings`
   - Set icon sizes:
     - 20x20 (iPhone Notification)
     - 29x29 (iPhone Settings)
     - 40x40 (iPhone Spotlight)
     - 60x60 (iPhone App)
     - 120x120, 180x180 (iPhone Retina)

2. **Launch Screen**
   ```swift
   // LaunchScreen.storyboard
   // Or use SwiftUI:
   @main
   struct EV2App: App {
       var body: some Scene {
           WindowGroup {
               ZStack {
                   Image("ev2_logo_icon")
                       .resizable()
                       .scaledToFit()
               }
           }
       }
   }
   ```

3. **Brand Assets**
   ```swift
   // Assets.xcassets
   Image("ev2_logo_full")
   Image("ev2_mascot_nacho")
   Image("ev2_logo_text")
   ```

## Android Setup

1. **App Icon**
   - Right-click `res → Image Asset`
   - Select "Icon" or "Notification Icons"
   - Upload your PNG
   - Android Studio generates all sizes

2. **Brand Assets**
   ```kotlin
   // res/drawable/
   R.drawable.ic_ev2_logo
   R.drawable.ic_ev2_mascot
   
   // Usage
   Image(
       painter = painterResource(id = R.drawable.ic_ev2_logo),
       contentDescription = "EV2 Logo",
       modifier = Modifier.size(64.dp)
   )
   ```

3. **Branding in Manifest**
   ```xml
   <!-- AndroidManifest.xml -->
   <application
       android:label="@string/app_name_ev2"
       android:icon="@drawable/ic_launcher"
       android:theme="@style/Theme.EV2Clandestinoz">
   ```

## Docker Setup for Assets

Create a volume mount in docker-compose.yml:

```yaml
services:
  easy-flirt-web:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./public/assets:/app/public/assets:ro
      - ./imagine_images:/app/imagine_images:ro
    environment:
      - ASSET_PATH=/assets
```

Access in app:

```html
<!-- These will be served by nginx -->
<img src="/assets/logos/ev2-logo-full.png">
<img src="/imagine_images/existing-images.jpg">
```

## Nginx Configuration

Update `nginx-nightclub.conf`:

```nginx
location /assets/ {
    alias /app/public/assets/;
    expires 7d;
    add_header Cache-Control "public, immutable";
}

location /imagine_images/ {
    alias /app/imagine_images/;
    expires 7d;
}
```

## Brand Color Usage Guidelines

### Primary Actions
Use `--ev2-cyan` (#00BFFF) for:
- Main buttons (Enter Club, Login)
- Active navigation
- Logo/branding

### Secondary Actions
Use `--ev2-pink` (#FF1493) for:
- Flirt/Romance actions
- Notifications
- Highlights

### Tertiary
Use `--ev2-purple`, `--ev2-lime`, or `--ev2-gold` for:
- Gradients
- Decorative elements
- Accents

### Backgrounds
Use `--ev2-dark-bg` (#0a0a14) for:
- Main background
- Dark surfaces

## Static Assets Deployment

### Step 1: Prepare Assets

```bash
mkdir -p public/assets/{logos,backgrounds}

# Copy your logos
cp ~/Downloads/ev2-logo-full.png public/assets/logos/
cp ~/Downloads/ev2-mascot-nacho.png public/assets/logos/
cp ~/Downloads/ev2-logo-icon.png public/assets/logos/
```

### Step 2: Build & Deploy

```bash
# Development
docker-compose up -d

# Production
docker-compose -f docker-compose.yml build --no-cache
docker-compose -f docker-compose.yml up -d

# Verify assets are served
curl http://localhost:8080/assets/logos/ev2-logo-full.png
```

### Step 3: Verify in Browser

```
http://localhost:8080  → Shows branded loading screen
App should display your EV2 logos and colors
```

## CDN Setup (Optional)

For production, use a CDN:

```bash
# Upload assets to AWS CloudFront / Cloudflare / Bunny CDN
aws s3 sync public/assets s3://your-bucket/assets

# Update URLs in code
<img src="https://cdn.ev2clandestinoz.com/assets/logos/ev2-logo-full.png">
```

## Files to Replace/Create

| File | Action | Purpose |
|------|--------|---------|
| `public/assets/logos/ev2-logo-full.png` | Create | Main logo display |
| `public/assets/logos/ev2-mascot-nacho.png` | Create | Colorful axolotl mascot |
| `public/assets/logos/ev2-logo-icon.png` | Create | Favicon & app icon |
| `Assets.xcassets/AppIcon` | Update (iOS) | App icon set |
| `res/drawable/ic_launcher.xml` | Update (Android) | App icon |
| `index-ev2-branded.html` | Use | Branded web UI |
| `EV2BrandedApp.swift` | Use | Branded iOS UI |
| `EV2Android.kt` | Use | Branded Android UI |

## Testing Branding

```bash
# Test web app
open http://localhost:8080

# Test iOS
xcode → Run on Simulator

# Test Android
android-studio → Run on Emulator

# Verify assets load
# Browser DevTools → Network tab → Check /assets/* requests
```

## Next Steps

1. ✅ Add logo image files to `public/assets/logos/`
2. ✅ Update iOS `Assets.xcassets` with your logos
3. ✅ Update Android `res/drawable/` with your logos
4. ✅ Rebuild and test all platforms
5. ✅ Deploy to production

---

**Note**: All branded files use the EV2 color scheme:
- Cyan (#00BFFF) as primary
- Pink (#FF1493) as secondary
- Dark backgrounds (#0a0a14)
