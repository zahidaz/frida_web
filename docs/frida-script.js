// Default script: Basic process information
console.log("Process ID:", Process.id);
console.log("Platform:", Process.platform);
console.log("Architecture:", Process.arch);
console.log("Code Signing Policy:", Process.codeSigningPolicy);

if (typeof Java !== 'undefined') {
    Java.perform(function() {
        console.log("Java runtime detected");
        console.log("Android API level:", Java.androidVersion);
    });
} else {
    console.log("No Java runtime (likely iOS/native process)");
}

console.log("Script execution completed successfully!");