param([Parameter(Mandatory=$true)][string]$Thumbprint)
$ErrorActionPreference = 'Stop'
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store 'My','CurrentUser'
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
$certificate = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $Thumbprint, $false) | Select-Object -First 1
if (-not $certificate) { throw 'The project development signing certificate was not found.' }
if ($certificate.Subject -ne 'CN=BewlyDownload.Local' -or $certificate.FriendlyName -ne 'BewlyDownload local development') {
    throw 'Only this project development certificate may sign this package.'
}
# Sign through the Windows key provider. Never export or print private key material.
$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
$inputStream = [Console]::OpenStandardInput()
$buffer = New-Object System.IO.MemoryStream
try {
    $inputStream.CopyTo($buffer)
    $signature = $rsa.SignData($buffer.ToArray(), [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    [Console]::Out.Write([Convert]::ToBase64String($signature))
}
finally { $buffer.Dispose(); $rsa.Dispose(); $store.Close() }
