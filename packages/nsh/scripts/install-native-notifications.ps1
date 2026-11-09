# Explicit per-user installation action, shipped beside the native runner. Not run by build/startup.
$ErrorActionPreference = 'Stop'
$identity = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'native-notification-identity.json') -Raw | ConvertFrom-Json
if ($identity.v -ne 1 -or $identity.aumid -ne 'com.yee94.yuri.nsh') { throw 'Invalid native application identity' }
$clsid = [Guid]::ParseExact($identity.activatorCLSID, 'D')
$exe = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'yuri-nsh-desktop.exe')).Path
$command = '"' + $exe + '" --notification-activation'
$key = 'HKCU:\Software\Classes\CLSID\{' + $clsid.ToString('D') + '}\LocalServer32'
if (Test-Path -LiteralPath $key) {
  $old = (Get-Item -LiteralPath $key).GetValue('')
  if ($old -ne $command) { throw 'Refusing to replace another COM server registration' }
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace YuriNativeInstaller {
 [ComImport,Guid("00021401-0000-0000-C000-000000000046")] class ShellLink {}
 [ComImport,Guid("000214F9-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IShellLink {
  void GetPath([Out,MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder p,int n,IntPtr data,uint flags);
  void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
  void GetDescription([Out,MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder p,int n);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string p);
  void GetWorkingDirectory([Out,MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder p,int n);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string p);
  void GetArguments([Out,MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder p,int n);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string p);
  void GetHotkey(out short k); void SetHotkey(short k); void GetShowCmd(out int s);void SetShowCmd(int s);
  void GetIconLocation([Out,MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder p,int n,out int i);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p,int i);void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p,uint r);
  void Resolve(IntPtr owner,uint flags);void SetPath([MarshalAs(UnmanagedType.LPWStr)] string p);
 }
 [StructLayout(LayoutKind.Sequential)] struct Key { public Guid format;public uint id;public Key(uint value){format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");id=value;} }
 [StructLayout(LayoutKind.Explicit,Size=24)] struct Variant { [FieldOffset(0)]public ushort kind;[FieldOffset(8)]public IntPtr pointer; }
 [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IPropertyStore {void GetCount(out uint count);void GetAt(uint i,out Key key);void GetValue(ref Key key,out Variant value);void SetValue(ref Key key,ref Variant value);void Commit();}
 public static class Shortcut {
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref Variant value);
  public static void Write(string path,string exe,string appID,Guid clsid) {
   if(IntPtr.Size!=8)throw new InvalidOperationException("64-bit installer required");
   object raw=new ShellLink();
   try {
    IShellLink link=(IShellLink)raw;
    if(System.IO.File.Exists(path)) {
     ((IPersistFile)raw).Load(path,0);var old=new System.Text.StringBuilder(32768);link.GetPath(old,32768,IntPtr.Zero,4);
     if(!String.Equals(old.ToString(),exe,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Shortcut belongs to another executable");
    }
    link.SetPath(exe);link.SetArguments("");link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(exe));link.SetDescription("Yuri Native");
    IPropertyStore properties=(IPropertyStore)raw;
    Key app=new Key(5);Variant name=new Variant();name.kind=31;name.pointer=Marshal.StringToCoTaskMemUni(appID);
    try {properties.SetValue(ref app,ref name);} finally {PropVariantClear(ref name);}
    Key activator=new Key(26);Variant id=new Variant();id.kind=72;id.pointer=Marshal.AllocCoTaskMem(16);Marshal.StructureToPtr(clsid,id.pointer,false);
    try {properties.SetValue(ref activator,ref id);} finally {PropVariantClear(ref id);}
    properties.Commit();((IPersistFile)raw).Save(path,true);
   } finally {Marshal.FinalReleaseComObject(raw);}
  }
 }
}
'@
$programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
if ([string]::IsNullOrWhiteSpace($programs)) { throw 'Per-user Programs folder unavailable' }
# Publish the shortcut before registration. A partial install is rejected by runner readback.
[YuriNativeInstaller.Shortcut]::Write((Join-Path $programs 'Yuri Native.lnk'), $exe, $identity.aumid, $clsid)
New-Item -Path $key -Force | Out-Null
Set-Item -LiteralPath $key -Value $command
Write-Output 'Native notification identity installed. No permission requested and no notification sent.'
