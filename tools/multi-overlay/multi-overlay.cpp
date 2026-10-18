// multi-overlay.cpp - multi-window overlay helper (4 border strips + banner +
// caption + ripple), each rendered on its own thread / layered window.
// Build: cl /nologo /LD /MT /EHsc /O2 multi-overlay.cpp /link user32.lib gdi32.lib gdiplus.lib
// Win32 + GDI+ only; no external runtime dependencies (/MT).

#define NOMINMAX
#include <windows.h>
#include <gdiplus.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace Gdiplus;

struct Surface {
    HDC dc = nullptr;
    HBITMAP bitmap = nullptr;
    HGDIOBJ old = nullptr;
    void* bits = nullptr;
    int w = 0;
    int h = 0;
    Graphics* graphics = nullptr;

    bool Create(int width, int height) {
        w = width; h = height;
        HDC screen = GetDC(nullptr);
        dc = CreateCompatibleDC(screen);
        BITMAPINFO bmi = {};
        bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;
        bitmap = CreateDIBSection(screen, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
        ReleaseDC(nullptr, screen);
        if (!bitmap || !bits) return false;
        old = SelectObject(dc, bitmap);
        graphics = new Graphics(dc);
        graphics->SetSmoothingMode(SmoothingModeAntiAlias);
        graphics->SetTextRenderingHint(TextRenderingHintAntiAlias);
        return true;
    }

    void Clear() {
        if (graphics) graphics->Clear(Color(0, 0, 0, 0));
    }

    void Destroy() {
        delete graphics; graphics = nullptr;
        if (dc) { if (old) SelectObject(dc, old); DeleteDC(dc); dc = nullptr; }
        if (bitmap) { DeleteObject(bitmap); bitmap = nullptr; }
        bits = nullptr;
    }
};

static HWND MakeWindow(const wchar_t* title, int x, int y, int w, int h) {
    HWND hwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
        L"STATIC", title, WS_POPUP, x, y, w, h, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    return hwnd;
}

static void Present(HWND hwnd, Surface& s, int x, int y) {
    HDC screen = GetDC(nullptr);
    POINT dst = {x, y};
    SIZE size = {s.w, s.h};
    POINT src = {0, 0};
    BLENDFUNCTION blend = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
    UpdateLayeredWindow(hwnd, screen, &dst, &size, s.dc, &src, 0, &blend, ULW_ALPHA);
    ReleaseDC(nullptr, screen);
}

struct MultiOverlay {
    int vx = 0, vy = 0, vw = 0, vh = 0;
    static const int B = 24;
    std::atomic<bool> active{false};
    std::atomic<bool> stop{false};
    HWND strips[4] = {};
    std::thread stripThreads[4];
    HWND banner = nullptr;
    std::thread bannerThread;
    HWND caption = nullptr;
    std::thread captionThread;
    HWND ripple = nullptr;
    std::thread rippleThread;
    std::mutex captionMutex;
    std::wstring captionText;
    std::chrono::steady_clock::time_point captionUntil;
    std::mutex rippleMutex;
    int rippleX = 0, rippleY = 0;
    std::chrono::steady_clock::time_point rippleStart;
    ULONG_PTR gdiplusToken = 0;
};

static void DrawStrip(Surface& s, int edge, float pulse) {
    s.Clear();
    int alpha = static_cast<int>(70 + 70 * pulse);
    Color inner(alpha, 52, 211, 153);
    Color outer(0, 52, 211, 153);
    LinearGradientMode mode = (edge == 0 || edge == 1) ? LinearGradientModeVertical : LinearGradientModeHorizontal;
    LinearGradientBrush brush(RectF(0, 0, static_cast<REAL>(s.w), static_cast<REAL>(s.h)),
                              edge == 0 || edge == 2 ? inner : outer,
                              edge == 0 || edge == 2 ? outer : inner,
                              mode);
    s.graphics->FillRectangle(&brush, 0, 0, s.w, s.h);
    Pen core(Color(220, 110, 231, 183), 1.6f);
    if (edge == 0) s.graphics->DrawLine(&core, 0, 1, s.w, 1);
    else if (edge == 1) s.graphics->DrawLine(&core, 0, s.h - 2, s.w, s.h - 2);
    else if (edge == 2) s.graphics->DrawLine(&core, 1, 0, 1, s.h);
    else s.graphics->DrawLine(&core, s.w - 2, 0, s.w - 2, s.h);
}

static void StripLoop(MultiOverlay* o, int edge, int x, int y, int w, int h) {
    HWND hwnd = MakeWindow(L"dsh-multi-strip", x, y, w, h);
    o->strips[edge] = hwnd;
    Surface s;
    s.Create(w, h);
    bool visible = false;
    while (!o->stop.load()) {
        if (!o->active.load()) {
            if (visible) { ShowWindow(hwnd, SW_HIDE); visible = false; }
            Sleep(30);
            continue;
        }
        if (!visible) { ShowWindow(hwnd, SW_SHOWNOACTIVATE); visible = true; }
        float t = static_cast<float>(GetTickCount64()) / 1000.0f;
        float pulse = 0.5f + 0.5f * sinf(t * 1.2f + edge * 1.4f);
        DrawStrip(s, edge, pulse);
        Present(hwnd, s, x, y);
        MSG msg;
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg); DispatchMessageW(&msg);
        }
        Sleep(16);
    }
    s.Destroy();
    if (hwnd) DestroyWindow(hwnd);
}

// Dynamic-island style pill: a compact black capsule that springs open when a
// caption arrives, then contracts with a damped overshoot.  One layered window
// is resized/re-rendered on its own thread so the border strips stay untouched.
static void BannerLoop(MultiOverlay* o) {
    HWND hwnd = nullptr;
    HWND restore = GetForegroundWindow();
    Surface s;
    bool visible = false;
    int shownW = 0, shownH = 0;
    float open = 0.0f;
    float velocity = 0.0f;
    auto last = std::chrono::steady_clock::now();

    while (!o->stop.load()) {
        if (!o->active.load()) {
            if (hwnd && visible) { ShowWindow(hwnd, SW_HIDE); visible = false; }
            open = 0.0f;
            velocity = 0.0f;
            Sleep(16);
            continue;
        }

        std::wstring caption;
        {
            std::lock_guard<std::mutex> lock(o->captionMutex);
            if (std::chrono::steady_clock::now() < o->captionUntil) caption = o->captionText;
        }

        auto now = std::chrono::steady_clock::now();
        float dt = std::chrono::duration<float>(now - last).count();
        last = now;
        dt = std::max(0.001f, std::min(dt, 0.05f));

        // Damped spring with a little overshoot, like the Dynamic Island.
        const float target = caption.empty() ? 0.0f : 1.0f;
        const float stiffness = 210.0f;
        const float damping = 23.0f;
        velocity += (target - open) * stiffness * dt;
        velocity *= std::exp(-damping * dt);
        open += velocity * dt;
        if (open < 0.0f) { open = 0.0f; velocity = 0.0f; }
        if (open > 1.12f) { open = 1.12f; velocity = 0.0f; }
        const float eased = open > 1.0f ? 1.0f - (open - 1.0f) * 0.35f : open;

        const int w = 286 + static_cast<int>(214.0f * eased);
        const int h = 52 + static_cast<int>(18.0f * eased);
        const int x = o->vx + (o->vw - w) / 2;
        const int y = o->vy + 8;
        if (!hwnd) hwnd = MakeWindow(L"dsh-multi-banner", x, y, w, h);
        if (!hwnd) { Sleep(50); continue; }
        if (!visible) {
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            visible = true;
        }
        if (w != shownW || h != shownH || !s.graphics) {
            s.Destroy();
            s.Create(w, h);
            SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
            shownW = w; shownH = h;
            if (GetForegroundWindow() == hwnd && restore && restore != hwnd) SetForegroundWindow(restore);
        } else {
            SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        }

        s.Clear();
        const float radius = h / 2.0f;
        GraphicsPath pill;
        pill.AddArc(REAL(0), REAL(0), 2 * radius, 2 * radius, REAL(90), REAL(180));
        pill.AddArc(REAL(w) - 2 * radius, REAL(0), 2 * radius, 2 * radius, REAL(270), REAL(180));
        pill.CloseFigure();

        LinearGradientBrush bg(RectF(0, 0, REAL(w), REAL(h)),
                               Color(242, 9, 30, 20), Color(242, 2, 10, 7),
                               LinearGradientModeVertical);
        s.graphics->FillPath(&bg, &pill);
        // Soft inner glass highlight, brightest at the top-left.
        LinearGradientBrush gloss(RectF(0, 0, REAL(w), REAL(h) * 0.58f),
                                  Color(46, 255, 255, 255), Color(0, 255, 255, 255),
                                  LinearGradientModeVertical);
        s.graphics->FillPath(&gloss, &pill);
        Pen halo(Color(42, 52, 211, 153), 4.2f);
        s.graphics->DrawPath(&halo, &pill);
        Pen border(Color(185, 72, 231, 178), 1.2f);
        s.graphics->DrawPath(&border, &pill);
        Pen shine(Color(80, 220, 255, 240), 1.0f);
        s.graphics->DrawLine(&shine, 20, 1, w - 20, 1);

        // A slow, low-alpha sheen sweeping across the capsule.
        const float sweep = static_cast<float>(fmod(static_cast<double>(GetTickCount64()) * 0.11, static_cast<double>(w + 220))) - 110.0f;
        GraphicsState sheenState = s.graphics->Save();
        s.graphics->SetClip(&pill);
        LinearGradientBrush sheen(RectF(sweep, 0, 110, REAL(h)),
                                  Color(0, 255, 255, 255), Color(18, 255, 255, 255),
                                  LinearGradientModeHorizontal);
        s.graphics->FillRectangle(&sheen, REAL(sweep), REAL(0), REAL(110), REAL(h));
        s.graphics->Restore(sheenState);

        const float clock = static_cast<float>(GetTickCount64()) / 1000.0f;
        const float breath = 0.5f + 0.5f * sinf(clock * 2.094f); // ~3s breathing
        const float glowSize = 18.0f + 14.0f * breath;
        SolidBrush glow(Color(static_cast<BYTE>(28 + 72 * breath), 52, 211, 153));
        s.graphics->FillEllipse(&glow, 29.0f - glowSize / 2, 26.0f - glowSize / 2, glowSize, glowSize);
        SolidBrush coreGlow(Color(static_cast<BYTE>(70 + 90 * breath), 167, 243, 208));
        s.graphics->FillEllipse(&coreGlow, 22.0f, 19.0f, 14.0f, 14.0f);

        // Expanding ring: fades as it travels outward, like a slow breath.
        const float phase = fmod(clock, 3.0f) / 3.0f;
        const float ringSize = 16.0f + 14.0f * phase;
        Pen ring(Color(static_cast<BYTE>(130 * (1.0f - phase)), 167, 243, 208), 1.5f);
        s.graphics->DrawEllipse(&ring, 29.0f - ringSize / 2, 26.0f - ringSize / 2, ringSize, ringSize);

        const float dotSize = 7.5f + 2.5f * breath;
        SolidBrush dot(Color(255, static_cast<BYTE>(190 + 65 * breath), 255, 230));
        s.graphics->FillEllipse(&dot, 29.0f - dotSize / 2, 26.0f - dotSize / 2, dotSize, dotSize);

        Font titleFont(L"Microsoft YaHei UI", 15, FontStyleBold, UnitPixel);
        SolidBrush title(Color(255, 237, 255, 247));
        RectF titleMeasure;
        s.graphics->MeasureString(L"Agent正在操控此电脑", -1, &titleFont, PointF(0, 0), &titleMeasure);
        float titleX = 46.0f + ((static_cast<float>(w) - titleMeasure.Width) / 2.0f - 46.0f) * std::min(1.0f, eased);
        if (titleX < 46.0f) titleX = 46.0f;
        s.graphics->DrawString(L"Agent正在操控此电脑", -1, &titleFont, PointF(titleX, 16), &title);

        if (!caption.empty() && eased > 0.08f) {
            const BYTE alpha = static_cast<BYTE>(std::min(1.0f, eased) * 235.0f);
            Font captionFont(L"Microsoft YaHei UI", 12, FontStyleRegular, UnitPixel);
            SolidBrush captionBrush(Color(alpha, 196, 245, 220));
            const float slide = (1.0f - std::min(1.0f, eased)) * 6.0f;
            RectF captionMeasure;
            s.graphics->MeasureString(caption.c_str(), -1, &captionFont, PointF(0, 0), &captionMeasure);
            float captionX = 46.0f + ((static_cast<float>(w) - captionMeasure.Width) / 2.0f - 46.0f) * std::min(1.0f, eased);
            if (captionX < 46.0f) captionX = 46.0f;
            RectF captionRect(captionX, 34 + slide, captionMeasure.Width + 4.0f, 20);
            StringFormat fmt;
            fmt.SetTrimming(StringTrimmingEllipsisCharacter);
            fmt.SetFormatFlags(StringFormatFlagsNoWrap);
            s.graphics->DrawString(caption.c_str(), -1, &captionFont, captionRect, &fmt, &captionBrush);
        }

        Present(hwnd, s, x, y);
        // A topmost popup can still grab the foreground on some Windows builds.
        // Hand focus back immediately; the island must stay non-interactive.
        if (restore && restore != hwnd && GetForegroundWindow() == hwnd) SetForegroundWindow(restore);
        MSG msg;
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        Sleep(16);
    }

    s.Destroy();
    if (hwnd) DestroyWindow(hwnd);
}

static void DrawCaption(MultiOverlay* o) {
    std::wstring text;
    std::chrono::steady_clock::time_point until;
    {
        std::lock_guard<std::mutex> lock(o->captionMutex);
        text = o->captionText;
        until = o->captionUntil;
    }
    const int w = 760, h = 42;
    if (!o->caption) {
        o->caption = MakeWindow(L"dsh-multi-caption", o->vx + (o->vw - w) / 2, o->vy + 78, w, h);
    }
    if (text.empty() || std::chrono::steady_clock::now() >= until || !o->active.load()) {
        ShowWindow(o->caption, SW_HIDE);
        return;
    }
    Surface s;
    s.Create(w, h);
    s.Clear();
    GraphicsPath path;
    path.AddArc(0, 0, h, h, 90, 180);
    path.AddArc(w - h, 0, h, h, 270, 180);
    path.CloseFigure();
    SolidBrush bg(Color(210, 4, 18, 11));
    s.graphics->FillPath(&bg, &path);
    Pen border(Color(160, 52, 211, 153), 1.0f);
    s.graphics->DrawPath(&border, &path);
    Font font(L"Microsoft YaHei UI", 13, FontStyleRegular, UnitPixel);
    SolidBrush fg(Color(255, 224, 255, 240));
    StringFormat fmt;
    fmt.SetAlignment(StringAlignmentCenter);
    fmt.SetLineAlignment(StringAlignmentCenter);
    RectF rect(12, 0, w - 24, static_cast<REAL>(h));
    s.graphics->DrawString(text.c_str(), -1, &font, rect, &fmt, &fg);
    Present(o->caption, s, o->vx + (o->vw - w) / 2, o->vy + 78);
    s.Destroy();
    ShowWindow(o->caption, SW_SHOWNOACTIVATE);
}

static void CaptionLoop(MultiOverlay* o) {
    while (!o->stop.load()) {
        DrawCaption(o);
        Sleep(50);
    }
}

static void DrawRipple(MultiOverlay* o) {
    int x = 0, y = 0;
    std::chrono::steady_clock::time_point start;
    {
        std::lock_guard<std::mutex> lock(o->rippleMutex);
        x = o->rippleX; y = o->rippleY; start = o->rippleStart;
    }
    const int size = 160;
    if (!o->ripple) o->ripple = MakeWindow(L"dsh-multi-ripple", o->vx, o->vy, size, size);
    if (!o->active.load() || x == 0 && y == 0) { ShowWindow(o->ripple, SW_HIDE); return; }
    float age = std::chrono::duration<float>(std::chrono::steady_clock::now() - start).count();
    if (age > 0.9f) { ShowWindow(o->ripple, SW_HIDE); return; }
    float progress = age / 0.7f;
    if (progress > 1.0f) progress = 1.0f;
    Surface s;
    s.Create(size, size);
    s.Clear();
    float radius = 10 + 46 * progress;
    int alpha = static_cast<int>(200 * (1 - progress));
    Pen pen(Color(alpha, 52, 211, 153), 2.4f);
    s.graphics->DrawEllipse(&pen, REAL(size / 2.0f - radius), REAL(size / 2.0f - radius), REAL(radius * 2), REAL(radius * 2));
    SolidBrush dot(Color(static_cast<BYTE>(alpha), 167, 243, 208));
    s.graphics->FillEllipse(&dot, REAL(size / 2.0f - 3), REAL(size / 2.0f - 3), REAL(6), REAL(6));
    Present(o->ripple, s, x - size / 2, y - size / 2);
    s.Destroy();
    ShowWindow(o->ripple, SW_SHOWNOACTIVATE);
}

static void RippleLoop(MultiOverlay* o) {
    while (!o->stop.load()) {
        DrawRipple(o);
        Sleep(16);
    }
}

extern "C" __declspec(dllexport) void* __stdcall MultiOverlay_Create() {
    SetProcessDpiAwarenessContext((DPI_AWARENESS_CONTEXT)-4);
    auto* o = new (std::nothrow) MultiOverlay();
    if (!o) return nullptr;
    GdiplusStartupInput input;
    if (GdiplusStartup(&o->gdiplusToken, &input, nullptr) != Ok) { delete o; return nullptr; }
    o->vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    o->vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    o->vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    o->vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    o->bannerThread = std::thread(BannerLoop, o);
    const int B = MultiOverlay::B;
    o->stripThreads[0] = std::thread(StripLoop, o, 0, o->vx, o->vy, o->vw, B);
    o->stripThreads[1] = std::thread(StripLoop, o, 1, o->vx, o->vy + o->vh - B, o->vw, B);
    o->stripThreads[2] = std::thread(StripLoop, o, 2, o->vx, o->vy + B, B, o->vh - 2 * B);
    o->stripThreads[3] = std::thread(StripLoop, o, 3, o->vx + o->vw - B, o->vy + B, B, o->vh - 2 * B);
    o->rippleThread = std::thread(RippleLoop, o);
    return o;
}

extern "C" __declspec(dllexport) void __stdcall MultiOverlay_Show(void* handle) {
    auto* o = static_cast<MultiOverlay*>(handle);
    if (!o) return;
    o->active.store(true);
    if (o->banner) ShowWindow(o->banner, SW_SHOWNOACTIVATE);
}

extern "C" __declspec(dllexport) void __stdcall MultiOverlay_Hide(void* handle) {
    auto* o = static_cast<MultiOverlay*>(handle);
    if (!o) return;
    o->active.store(false);
    if (o->banner) ShowWindow(o->banner, SW_HIDE);
    if (o->caption) ShowWindow(o->caption, SW_HIDE);
    if (o->ripple) ShowWindow(o->ripple, SW_HIDE);
}

extern "C" __declspec(dllexport) void __stdcall MultiOverlay_Caption(void* handle, const wchar_t* text, int ttlMs) {
    auto* o = static_cast<MultiOverlay*>(handle);
    if (!o) return;
    std::lock_guard<std::mutex> lock(o->captionMutex);
    o->captionText = text ? text : L"";
    o->captionUntil = std::chrono::steady_clock::now() + std::chrono::milliseconds(ttlMs > 0 ? ttlMs : 1600);
}

// UTF-8 variant avoids any ANSI/Unicode marshaling ambiguity at the ABI boundary.
extern "C" __declspec(dllexport) void __stdcall MultiOverlay_CaptionUtf8(void* handle, const char* utf8, int ttlMs) {
    auto* o = static_cast<MultiOverlay*>(handle);
    if (!o) return;
    std::wstring wide;
    if (utf8 && *utf8) {
        int len = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
        if (len > 1) {
            wide.resize(static_cast<size_t>(len - 1));
            MultiByteToWideChar(CP_UTF8, 0, utf8, -1, &wide[0], len);
        }
    }
    std::lock_guard<std::mutex> lock(o->captionMutex);
    o->captionText = wide;
    o->captionUntil = std::chrono::steady_clock::now() + std::chrono::milliseconds(ttlMs > 0 ? ttlMs : 1600);
}

extern "C" __declspec(dllexport) void __stdcall MultiOverlay_Ripple(void* handle, int x, int y) {
    auto* o = static_cast<MultiOverlay*>(handle);
    if (!o) return;
    std::lock_guard<std::mutex> lock(o->rippleMutex);
    o->rippleX = x; o->rippleY = y;
    o->rippleStart = std::chrono::steady_clock::now();
}

extern "C" __declspec(dllexport) void __stdcall MultiOverlay_Destroy(void* handle) {
    auto* o = static_cast<MultiOverlay*>(handle);
    if (!o) return;
    o->stop.store(true);
    o->active.store(false);
    // The host quits immediately after this call; detach workers instead of
    // joining them so shutdown cannot block on a layered-window present.
    for (auto& t : o->stripThreads) if (t.joinable()) t.detach();
    if (o->bannerThread.joinable()) o->bannerThread.detach();
    if (o->captionThread.joinable()) o->captionThread.detach();
    if (o->rippleThread.joinable()) o->rippleThread.detach();
    // Do not destroy HWNDs/GDI+ from a different thread while workers may still
    // be inside UpdateLayeredWindow; the host exits immediately after this call.
    // Intentionally leak o: detached workers may still touch it for a few ms.
}
