#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// CFBundleExecutable must be a Mach-O binary; codesign refuses a shell script.
// This launcher only forwards to the shared POSIX shell entry point so macOS and
// Linux keep exactly one implementation of the runtime/registration logic.
int main(int argc, char **argv) {
    char executable[PATH_MAX];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) != 0) return 1;

    char resolved[PATH_MAX];
    if (realpath(executable, resolved) == NULL) return 1;

    char *slash = strrchr(resolved, '/');
    if (slash == NULL) return 1;
    *slash = '\0';

    char script[PATH_MAX];
    int written = snprintf(script, sizeof(script), "%s/../Resources/native/posix/launcher.sh", resolved);
    if (written <= 0 || written >= (int)sizeof(script)) return 1;

    char **arguments = calloc((size_t)argc + 2, sizeof(char *));
    if (arguments == NULL) return 1;
    int index = 0;
    arguments[index++] = "/bin/sh";
    arguments[index++] = script;
    if (argc > 1) {
        for (int i = 1; i < argc; i++) arguments[index++] = argv[i];
    } else {
        arguments[index++] = "first-run";
    }
    arguments[index] = NULL;

    execv("/bin/sh", arguments);
    return 1;
}
