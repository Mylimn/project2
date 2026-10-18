# 生成扩展图标（16/48/128 PNG），仅在需要重建图标时运行
# 用法: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'icons'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

foreach ($s in 16, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # 背景：圆角方形 + 蓝紫渐变
    $bgRect = New-Object System.Drawing.RectangleF(0, 0, $s, $s)
    $bgPath = New-RoundedPath 0.5 0.5 ($s - 1) ($s - 1) ($s * 0.22)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($bgRect, [System.Drawing.Color]::FromArgb(255, 79, 124, 255), [System.Drawing.Color]::FromArgb(255, 124, 77, 255), 45.0)
    $g.FillPath($brush, $bgPath)

    # 前景：白色图片相框
    $fx = $s * 0.20; $fy = $s * 0.26; $fw = $s * 0.60; $fh = $s * 0.48
    $frame = New-RoundedPath $fx $fy $fw $fh ($s * 0.09)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillPath($white, $frame)

    # 相框内的太阳
    $dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 79, 124, 255))
    $g.FillEllipse($dot, ($s * 0.28), ($s * 0.33), ($s * 0.11), ($s * 0.11))

    # 相框内的山
    $tri = @(
        (New-Object System.Drawing.PointF(($s * 0.24), ($s * 0.70))),
        (New-Object System.Drawing.PointF(($s * 0.42), ($s * 0.46))),
        (New-Object System.Drawing.PointF(($s * 0.60), ($s * 0.70)))
    )
    $g.FillPolygon($dot, $tri)

    $path = Join-Path $outDir ("icon{0}.png" -f $s)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

    $dot.Dispose(); $white.Dispose(); $brush.Dispose(); $frame.Dispose(); $bgPath.Dispose(); $g.Dispose(); $bmp.Dispose()
    Write-Host ("generated {0}" -f $path)
}
