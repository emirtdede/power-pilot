fn main() {
    println!("cargo:rerun-if-changed=ui/index.html");
    println!("cargo:rerun-if-changed=ui/setup.css");
    println!("cargo:rerun-if-changed=ui/setup.js");
    println!("cargo:rerun-if-changed=ui/i18n-73.js");
    println!("cargo:rerun-if-changed=../src/assets/icons/monochrome-dark.ico");

    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../src/assets/icons/monochrome-dark.ico");
        res.set("ProductName", "Power Pilot");
        res.set("FileDescription", "Power Pilot Setup");
        res.set("CompanyName", "Vellium Teknoloji Anonim Sirketi");
        res.set("LegalCopyright", "Copyright (c) 2026 Vellium Teknoloji Anonim Sirketi");
        res.set("OriginalFilename", "Power Pilot Setup 1.0.0.exe");
        res.set_manifest(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0" xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="amd64" name="Vellium.PowerPilot.Setup" type="win32"/>
  <description>Power Pilot Setup</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <asmv3:application>
    <asmv3:windowsSettings>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </asmv3:windowsSettings>
  </asmv3:application>
</assembly>"#,
        );
        if let Err(err) = res.compile() {
            panic!("Failed to compile Windows resources: {err}");
        }
    }
}
