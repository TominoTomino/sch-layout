$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:SCH_LAYOUT_REPO) { $env:SCH_LAYOUT_REPO } else { "https://github.com/TominoTomino/sch-layout.git" }
$Src     = if ($env:SCH_LAYOUT_SRC)  { $env:SCH_LAYOUT_SRC }  else { Join-Path $HOME "code\sch-layout" }
$Skills  = if ($env:SCH_LAYOUT_SKILLS) { $env:SCH_LAYOUT_SKILLS } else { Join-Path $HOME ".workbuddy\skills" }
$Dest    = Join-Path $Skills "sch-layout"

Write-Host "sch-layout 安装"
Write-Host "  源目录 : $Src"
Write-Host "  目标   : $Dest"

if (-not (Test-Path (Join-Path $Src ".git"))) {
    Write-Host "-> 克隆仓库"
    New-Item -ItemType Directory -Force -Path (Split-Path $Src) | Out-Null
    git clone $RepoUrl $Src
} else {
    Write-Host "-> 源目录已存在，跳过克隆"
}

New-Item -ItemType Directory -Force -Path $Skills | Out-Null

if (Test-Path $Dest) {
    $item = Get-Item $Dest -Force
    if ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") {
        Write-Host "-> 已存在链接，重建"
        cmd /c rmdir "$Dest"
    } else {
        Write-Host "! $Dest 已存在且不是链接。"
        Write-Host "  如需改为链接安装，请先: Rename-Item `"$Dest`" `"sch-layout.bak`""
        exit 1
    }
}

# 目录联接（junction）无需管理员权限，优于 symlink
cmd /c mklink /J "$Dest" "$Src" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "创建目录联接失败" }
Write-Host "-> 已链接（junction）"

if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "-> 自检"
    node (Join-Path $Src "scripts\lint.mjs") (Join-Path $Src "samples\demo-page.json") | Select-Object -First 4
} else {
    Write-Host "! 未找到 node（需要 >= 20）"
}

Write-Host "完成。新对话中提到「原理图」会自动命中本 skill。"
