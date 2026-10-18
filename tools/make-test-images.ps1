# 生成端到端测试用的示例图片（一次性脚本）
# 用法: powershell -ExecutionPolicy Bypass -File tools/make-test-images.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'test\img'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-TestImage {
    param(
        [string]$Name,
        [int]$Width,
        [int]$Height,
        [string]$Color1,
        [string]$Color2,
        [string]$Label,
        [string]$Format = 'jpeg'
    )

    $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $rect = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.ColorTranslator]::FromHtml($Color1),
        [System.Drawing.ColorTranslator]::FromHtml($Color2),
        45.0
    )
    $g.FillRectangle($brush, $rect)

    # 网格线，便于肉眼确认转换后的尺寸是否正确
    if ($Width -gt 40 -and $Height -gt 40) {
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(38, 255, 255, 255), 2)
        for ($x = 100; $x -lt $Width; $x += 100) { $g.DrawLine($pen, $x, 0, $x, $Height) }
        for ($y = 100; $y -lt $Height; $y += 100) { $g.DrawLine($pen, 0, $y, $Width, $y) }
        $pen.Dispose()

        $fontSize = [Math]::Max(12, [Math]::Min($Width, $Height) / 7)
        $font = New-Object System.Drawing.Font('Arial', $fontSize, [System.Drawing.FontStyle]::Bold)
        $sf = New-Object System.Drawing.StringFormat
        $sf.Alignment = [System.Drawing.StringAlignment]::Center
        $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
        $textRect = New-Object System.Drawing.RectangleF(0, 0, $Width, $Height)
        $g.DrawString($Label, $font, [System.Drawing.Brushes]::White, $textRect, $sf)
        $font.Dispose()
        $sf.Dispose()
    }

    $path = Join-Path $outDir $Name
    if ($Format -eq 'png') {
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    } else {
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, [long]85
        )
        $bmp.Save($path, $codec, $encParams)
    }

    $g.Dispose()
    $brush.Dispose()
    $bmp.Dispose()
    Write-Host ("generated {0} ({1}x{2})" -f $Name, $Width, $Height)
}

New-TestImage -Name 'product-1.jpg' -Width 800 -Height 600 -Color1 '#4f7cff' -Color2 '#7c4dff' -Label 'PRODUCT 1'
New-TestImage -Name 'product-1.jpg_400x400.jpg' -Width 400 -Height 400 -Color1 '#4f7cff' -Color2 '#7c4dff' -Label 'THUMB 400'
New-TestImage -Name 'product-2.jpg' -Width 640 -Height 480 -Color1 '#0ea5e9' -Color2 '#2563eb' -Label 'PRODUCT 2'
New-TestImage -Name 'product-3.jpg' -Width 1200 -Height 1200 -Color1 '#10b981' -Color2 '#047857' -Label 'PRODUCT 3'
New-TestImage -Name 'product-4.jpg' -Width 520 -Height 520 -Color1 '#f59e0b' -Color2 '#ea580c' -Label 'PRODUCT 4'
New-TestImage -Name 'product-5.jpg' -Width 900 -Height 900 -Color1 '#ec4899' -Color2 '#be185d' -Label 'PRODUCT 5'
New-TestImage -Name 'product-6.jpg' -Width 480 -Height 480 -Color1 '#8b5cf6' -Color2 '#6d28d9' -Label 'PRODUCT 6'
New-TestImage -Name 'product-7.jpg' -Width 480 -Height 480 -Color1 '#14b8a6' -Color2 '#0f766e' -Label 'PRODUCT 7'
New-TestImage -Name 'product-8.jpg' -Width 640 -Height 360 -Color1 '#ef4444' -Color2 '#991b1b' -Label 'PRODUCT 8'
New-TestImage -Name 'product-icon.png' -Width 800 -Height 800 -Color1 '#64748b' -Color2 '#334155' -Label 'ICON NAME' -Format 'png'
New-TestImage -Name 'small-banner.png' -Width 80 -Height 80 -Color1 '#fbbf24' -Color2 '#d97706' -Label '80' -Format 'png'
New-TestImage -Name 'logo-icon.png' -Width 32 -Height 32 -Color1 '#94a3b8' -Color2 '#475569' -Label 'L' -Format 'png'
New-TestImage -Name 'pixel.png' -Width 1 -Height 1 -Color1 '#ffffff' -Color2 '#ffffff' -Label '' -Format 'png'
New-TestImage -Name 'sprite-sheet.png' -Width 400 -Height 400 -Color1 '#cbd5e1' -Color2 '#64748b' -Label 'SPRITE' -Format 'png'
New-TestImage -Name 'small-thumb.png' -Width 200 -Height 200 -Color1 '#a3a3a3' -Color2 '#525252' -Label '200' -Format 'png'
