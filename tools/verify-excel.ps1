# verify-excel.ps1 — 生成した名簿を Excel 本体で開いて、壊れていないことを確認する。
#
#   powershell -ExecutionPolicy Bypass -File tools\verify-excel.ps1
#
# node tools/verify-roster.mjs が dist\検証用_参加者名簿.xlsx を作った後に走らせる。
# XML の検査だけでは「Excel が修復ダイアログを出さずに開けるか」は分からないので、
# 実物の Excel に開かせるところまでやる。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$file = Join-Path $root 'tmp\検証用_参加者名簿.xlsx'

if (-not (Test-Path $file)) {
    Write-Output "検証用ファイルがありません。先に node tools/verify-roster.mjs を実行してください。"
    exit 1
}

$fail = 0
function Check($label, $ok, $detail) {
    $mark = if ($ok) { '  OK  ' } else { '  NG  ' }
    $suffix = if ($detail) { "  — $detail" } else { '' }
    Write-Output "$mark $label$suffix"
    if (-not $ok) { $script:fail++ }
}

Write-Output "Excel で開いて確認`n"

$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
$xl.AskToUpdateLinks = $false

$wb = $null
try {
    # 破損していると Excel は「修復して開く」ダイアログを出す。DisplayAlerts=$false なら
    # 例外か、CorruptLoad の痕跡として現れる。
    $wb = $xl.Workbooks.Open($file, 0, $true)
    Check "修復ダイアログなしで開ける" $true ""

    $ws = $wb.Worksheets.Item(1)
    Check "シート名が 参加者名簿" ($ws.Name -eq '参加者名簿') $ws.Name

    $lo = $null
    try { $lo = $ws.ListObjects.Item('テーブル1') } catch { }
    Check "テーブル1 が生きている" ($null -ne $lo) $(if ($lo) { $lo.Range.Address($false, $false) } else { '見つかりません' })

    Check "B1 申請者氏名" ($ws.Range('B1').Value2 -eq 'テスト 申請者') $ws.Range('B1').Value2
    Check "B2 活動名"     ($ws.Range('B2').Value2 -eq 'テスト団体での活動') $ws.Range('B2').Value2
    Check "B3 責任者名"   ($ws.Range('B3').Value2 -eq 'テスト 責任者') $ws.Range('B3').Value2

    Check "B11 学籍番号が文字列" ($ws.Range('B11').Value2 -is [string] -and $ws.Range('B11').Value2 -eq '1A123456') $ws.Range('B11').Value2
    # 全角スペース(U+3000)が半角に化けていないことも兼ねて確認する
    $ideoSpace = [char]0x3000
    Check "C11 カナ氏名（全角スペース保持）" ($ws.Range('C11').Value2 -eq ('ワセダ' + $ideoSpace + 'タロウ')) $ws.Range('C11').Value2

    # 日付はシリアル値（数値）で入り、表示書式が日付になっているのが正
    $d11 = $ws.Range('D11')
    Check "D11 申請年月日が数値" ($d11.Value2 -is [double]) ("{0} ({1})" -f $d11.Value2, $d11.Value2.GetType().Name)
    Check "D11 の表示書式が日付" ($d11.NumberFormat -match 'y|m|d') $d11.NumberFormat
    Check "D11 が 2026/8/24 として読める" ($d11.Text -match '2026') $d11.Text
    Check "E11 活動開始日が 2026/9/1" ($ws.Range('E11').Text -match '9') $ws.Range('E11').Text

    Check "G11 活動場所（< > & が復元される）" ($ws.Range('G11').Value2 -eq '早稲田大学 早稲田キャンパス <7号館> & 周辺') $ws.Range('G11').Value2

    # status 列。fullCalcOnLoad で再計算された結果を見る
    Check "H11 status が T" ($ws.Range('H11').Value2 -eq 'T') $ws.Range('H11').Value2
    Check "H12 status が T" ($ws.Range('H12').Value2 -eq 'T') $ws.Range('H12').Value2
    Check "H13 status が T" ($ws.Range('H13').Value2 -eq 'T') $ws.Range('H13').Value2
    Check "未使用行 H14 が F" ($ws.Range('H14').Value2 -eq 'F') $ws.Range('H14').Value2
    Check "H11 が数式のまま" ($ws.Range('H11').HasFormula) $ws.Range('H11').Formula

    Check "A列の No が残っている" ($ws.Range('A11').Value2 -eq 1 -and $ws.Range('A60').Value2 -eq 50) ("A11={0} A60={1}" -f $ws.Range('A11').Value2, $ws.Range('A60').Value2)

    # データ検証（学籍番号8桁 / カナ IME）
    $v = $null
    try { $v = $ws.Range('B11').Validation.Formula1 } catch { }
    Check "B11 のデータ検証が残っている" ($v -eq '8') $v
    $ime = $null
    try { $ime = $ws.Range('C11').Validation.IMEMode } catch { }
    Check "C11 の IME 設定が残っている" ($null -ne $ime) $ime

    Check "結合セル B1:C1 が残っている" ($ws.Range('B1').MergeArea.Address($false,$false) -eq 'B1:C1') $ws.Range('B1').MergeArea.Address($false,$false)
}
catch {
    Check "Excel での読み込み" $false $_.Exception.Message
}
finally {
    if ($wb) { $wb.Close($false) }
    $xl.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
    [GC]::Collect()
}

Write-Output ""
if ($fail -eq 0) { Write-Output "全て通りました。" } else { Write-Output "$fail 件失敗しました。" }
exit $(if ($fail -eq 0) { 0 } else { 1 })
