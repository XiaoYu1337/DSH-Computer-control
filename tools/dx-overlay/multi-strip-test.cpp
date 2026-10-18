// multi-strip-test.cpp - prototype: 4 border strip layered windows + banner,
// each strip rendered on its own thread. Measures CPU and FPS.
// Build: cl /nologo /MT /EHsc /O2 multi-strip-test.cpp /link user32.lib gdi32.lib

#include <windows.h>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>

static std::atomic<bool> g_stop(false);
static int g_width = 0;
static int g_height = 0;

struct Surface {
    HDC dc = nullptr;
    HBITMAP bitmap = nullptr;
    HGDIOBJ old = nullptr;
    void* bits = nullptr;
    int w = 0;
    int h = 0;
};

static Surface CreateSurface(int w, int h) {
    Surface s;
    s.w = w;
    s.h = h;
    HDC screen = GetDC(nullptr);
    s.dc = CreateCompatibleDC(screen);
    BITMAPINFO bmi = {};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    s.bitmap = CreateDIBSection(screen, &bmi, DIB_RGB_COLORS, &s.bits, nullptr, 0);
    s.old = SelectObject(s.dc, s.bitmap);
    ReleaseDC(nullptr, screen);
    return s;
}

static void FillSurface(Surface& s, int r, int g, int b, int a) {
    auto* pixels = static_cast<unsigned char*>(s.bits);
    const unsigned char pr = static_cast<unsigned char>(r * a / 255);
    const unsigned char pg = static_cast<unsigned char>(g * a / 255);
    const unsigned char pb = static_cast<unsigned char>(b * a / 255);
    for (int y = 0; y < s.h; ++y) {
        for (int x = 0; x < s.w; ++x) {
            unsigned char* p = pixels + (static_cast<size_t>(y) * s.w + x) * 4;
            p[0] = pb; p[1] = pg; p[2] = pr; p[3] = static_cast<unsigned char>(a);
        }
    }
}

static HWND CreateStripWindow(int x, int y, int w, int h) {
    HWND hwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
        L"STATIC", L"dsh-strip", WS_POPUP, x, y, w, h, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (hwnd == nullptr) return nullptr;
    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
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

struct StripArgs {
    int x, y, w, h;
    int phase;
    std::atomic<int>* frames;
};

static void StripThread(StripArgs args) {
    HWND hwnd = CreateStripWindow(args.x, args.y, args.w, args.h);
    if (hwnd == nullptr) return;
    Surface s = CreateSurface(args.w, args.h);
    int frame = 0;
    while (!g_stop.load()) {
        float t = static_cast<float>(GetTickCount64()) / 1000.0f;
        float pulse = 0.5f + 0.5f * sinf(t * 1.2f + args.phase);
        int alpha = 70 + static_cast<int>(pulse * 80);
        FillSurface(s, 52, 211, 153, alpha);
        Present(hwnd, s, args.x, args.y);
        (*args.frames)++;
        frame++;
        MSG msg;
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        Sleep(16);
    }
    SelectObject(s.dc, s.old);
    DeleteObject(s.bitmap);
    DeleteDC(s.dc);
    DestroyWindow(hwnd);
}

int main(int argc, char** argv) {
    SetProcessDpiAwarenessContext((DPI_AWARENESS_CONTEXT)-4);
    g_width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    g_height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    const int seconds = argc > 1 ? atoi(argv[1]) : 6;
    const int B = 24;
    std::atomic<int> frames[4] = {};
    std::vector<std::thread> threads;
    StripArgs args[4] = {
        {0, 0, g_width, B, 0.0f, &frames[0]},
        {0, g_height - B, g_width, B, 1.4f, &frames[1]},
        {0, B, B, g_height - 2 * B, 2.8f, &frames[2]},
        {g_width - B, B, B, g_height - 2 * B, 4.2f, &frames[3]},
    };
    for (int i = 0; i < 4; ++i) threads.emplace_back(StripThread, args[i]);

    // static banner window
    const int bw = 500, bh = 56;
    HWND banner = CreateStripWindow((g_width - bw) / 2, 8, bw, bh);
    Surface bs = CreateSurface(bw, bh);
    FillSurface(bs, 6, 20, 14, 235);
    Present(banner, bs, (g_width - bw) / 2, 8);

    FILETIME c0, e0, k0, u0, c1, e1, k1, u1;
    GetProcessTimes(GetCurrentProcess(), &c0, &e0, &k0, &u0);
    Sleep(static_cast<DWORD>(seconds) * 1000);
    GetProcessTimes(GetCurrentProcess(), &c1, &e1, &k1, &u1);
    ULARGE_INTEGER a, b;
    a.LowPart = k0.dwLowDateTime; a.HighPart = k0.dwHighDateTime;
    b.LowPart = k1.dwLowDateTime; b.HighPart = k1.dwHighDateTime;
    double cpuMs = static_cast<double>(b.QuadPart - a.QuadPart) / 10000.0;
    a.LowPart = u0.dwLowDateTime; a.HighPart = u0.dwHighDateTime;
    b.LowPart = u1.dwLowDateTime; b.HighPart = u1.dwHighDateTime;
    cpuMs += static_cast<double>(b.QuadPart - a.QuadPart) / 10000.0;

    g_stop.store(true);
    for (auto& t : threads) t.join();
    int total = 0;
    for (int i = 0; i < 4; ++i) total += frames[i].load();
    printf("virtual=%dx%d seconds=%d frames=%d fps=%.1f cpu=%.1f%% oneCore\n",
           g_width, g_height, seconds, total, total / static_cast<double>(seconds),
           cpuMs / (static_cast<double>(seconds) * 10.0));
    SelectObject(bs.dc, bs.old);
    DeleteObject(bs.bitmap);
    DeleteDC(bs.dc);
    if (banner) DestroyWindow(banner);
    return 0;
}
