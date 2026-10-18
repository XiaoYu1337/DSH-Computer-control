// dx-overlay.cpp - minimal DirectComposition presenter for the DSH overlay.
// Build (x64): cl /nologo /LD /MT /EHsc /O2 dx-overlay.cpp /link d3d11.lib dxgi.lib dcomp.lib
// The host owns the window; this DLL owns D3D11/DXGI/DComp objects only.

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <dcomp.h>
#include <wrl/client.h>

#include <cstring>

using Microsoft::WRL::ComPtr;

static HRESULT g_lastError = S_OK;
static int g_lastStage = 0;

struct DxOverlay {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGISwapChain1> swapChain;
    ComPtr<IDCompositionDevice> dcomp;
    ComPtr<IDCompositionTarget> target;
    ComPtr<IDCompositionVisual> visual;
    ComPtr<ID3D11Texture2D> texture;
    int width = 0;
    int height = 0;
};

static HRESULT CreateDevice(ComPtr<ID3D11Device>& device, ComPtr<ID3D11DeviceContext>& context) {
    D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    };
    D3D_FEATURE_LEVEL selected = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, &device, &selected, &context);
    if (FAILED(hr)) {
        hr = D3D11CreateDevice(
            nullptr, D3D_DRIVER_TYPE_WARP, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, &device, &selected, &context);
    }
    return hr;
}

extern "C" __declspec(dllexport) void* __stdcall DxOverlay_Create(HWND hwnd, int width, int height) {
    g_lastError = S_OK;
    if (hwnd == nullptr || width <= 0 || height <= 0) { g_lastError = E_INVALIDARG; return nullptr; }

    auto* overlay = new (std::nothrow) DxOverlay();
    if (overlay == nullptr) { g_lastError = E_OUTOFMEMORY; return nullptr; }
    overlay->width = width;
    overlay->height = height;

    HRESULT hr = CreateDevice(overlay->device, overlay->context);
    if (FAILED(hr)) {
        g_lastError = hr;
        g_lastStage = 1;
        delete overlay;
        return nullptr;
    }

    ComPtr<IDXGIDevice> dxgiDevice;
    ComPtr<IDXGIAdapter> adapter;
    ComPtr<IDXGIFactory2> factory;
    g_lastStage = 2;
    hr = overlay->device.As(&dxgiDevice);
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }
    g_lastStage = 3;
    hr = dxgiDevice->GetAdapter(&adapter);
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }
    g_lastStage = 4;
    hr = adapter->GetParent(IID_PPV_ARGS(&factory));
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }

    DXGI_SWAP_CHAIN_DESC1 desc = {};
    desc.Width = static_cast<UINT>(width);
    desc.Height = static_cast<UINT>(height);
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.Stereo = FALSE;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2;
    desc.Scaling = DXGI_SCALING_STRETCH;
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
    desc.AlphaMode = DXGI_ALPHA_MODE_PREMULTIPLIED;
    desc.Flags = 0;

    g_lastStage = 5;
    hr = factory->CreateSwapChainForComposition(overlay->device.Get(), &desc, nullptr, &overlay->swapChain);
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }

    g_lastStage = 6;
    hr = DCompositionCreateDevice(dxgiDevice.Get(), IID_PPV_ARGS(&overlay->dcomp));
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }
    g_lastStage = 7;
    hr = overlay->dcomp->CreateTargetForHwnd(hwnd, TRUE, &overlay->target);
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }
    g_lastStage = 8;
    hr = overlay->dcomp->CreateVisual(&overlay->visual);
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }
    g_lastStage = 9;
    hr = overlay->visual->SetContent(overlay->swapChain.Get());
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }
    g_lastStage = 10;
    hr = overlay->target->SetRoot(overlay->visual.Get());
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }
    g_lastStage = 11;
    hr = overlay->dcomp->Commit();
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }

    D3D11_TEXTURE2D_DESC td = {};
    td.Width = static_cast<UINT>(width);
    td.Height = static_cast<UINT>(height);
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = 0;
    td.CPUAccessFlags = 0;
    g_lastStage = 12;
    hr = overlay->device->CreateTexture2D(&td, nullptr, &overlay->texture);
    if (FAILED(hr)) { g_lastError = hr; delete overlay; return nullptr; }

    g_lastStage = 0;
    g_lastError = S_OK;
    return overlay;
}

extern "C" __declspec(dllexport) HRESULT __stdcall DxOverlay_GetLastError() {
    return g_lastError;
}

extern "C" __declspec(dllexport) int __stdcall DxOverlay_GetLastStage() {
    return g_lastStage;
}

extern "C" __declspec(dllexport) HRESULT __stdcall DxOverlay_Present(void* handle, const void* bits, int stride) {
    if (handle == nullptr || bits == nullptr || stride <= 0) return E_INVALIDARG;
    auto* overlay = static_cast<DxOverlay*>(handle);

    overlay->context->UpdateSubresource(overlay->texture.Get(), 0, nullptr, bits, stride, 0);
    ComPtr<ID3D11Texture2D> backBuffer;
    HRESULT hr = overlay->swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
    if (FAILED(hr)) return hr;
    overlay->context->CopyResource(backBuffer.Get(), overlay->texture.Get());
    hr = overlay->swapChain->Present(0, 0);
    if (hr == DXGI_STATUS_OCCLUDED) return S_OK;
    return hr;
}

extern "C" __declspec(dllexport) void __stdcall DxOverlay_Destroy(void* handle) {
    delete static_cast<DxOverlay*>(handle);
}
