/* SDK-owned kinfo_proc ABI only. No signal, parser, formatter or authority. */
#include <sys/types.h>
#include <sys/param.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

int caws_native_kinfo_comm(pid_t pid, int *is_zombie, uint8_t *comm,
                          size_t capacity, size_t *comm_length)
{
    struct kinfo_proc info = {0};
    size_t length = sizeof(info);
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    const char *end;
    size_t used;

    if (pid <= 0 || is_zombie == NULL || comm == NULL || comm_length == NULL ||
        capacity < sizeof(info.kp_proc.p_comm)) {
        return -1;
    }
    if (sysctl(mib, 4, &info, &length, NULL, 0) != 0 ||
        length != sizeof(info) || info.kp_proc.p_pid != pid) {
        return -1;
    }
    end = memchr(info.kp_proc.p_comm, '\0', sizeof(info.kp_proc.p_comm));
    if (end == NULL) {
        return -1;
    }
    used = (size_t)(end - info.kp_proc.p_comm);
    memcpy(comm, info.kp_proc.p_comm, used);
    *comm_length = used;
    *is_zombie = info.kp_proc.p_stat == SZOMB ? 1 : 0;
    return 0;
}
