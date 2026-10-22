/* Qualification-only SDK identity and System strvis oracles. No production policy. */
#include <sys/types.h>
#include <sys/time.h>
#include <sys/param.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <locale.h>
#include <xlocale.h>
#include <vis.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { ORACLE_MAX_INPUT = 4097, ORACLE_OUTPUT_CAPACITY = 4 * ORACLE_MAX_INPUT + 1 };

int caws_comm_oracle_locale_is_c(void)
{
    /* NULL arguments query only. A per-thread override is refused even if it
       happens to be a C clone, keeping the requirement explicit and observable. */
    const char *current = setlocale(LC_ALL, NULL);
    return current != NULL && strcmp(current, "C") == 0 &&
           uselocale((locale_t)0) == LC_GLOBAL_LOCALE;
}

uint32_t caws_comm_oracle_flags(void)
{
    return (uint32_t)(VIS_TAB | VIS_NL | VIS_NOSLASH);
}

int caws_comm_strvis_oracle(const uint8_t *input, size_t input_length,
                           uint8_t *output, size_t output_capacity,
                           size_t *output_length)
{
    char source[ORACLE_MAX_INPUT + 1];
    int length;
    if (!caws_comm_oracle_locale_is_c()) {
        return -2;
    }
    if (input == NULL || output == NULL || output_length == NULL ||
        input_length > ORACLE_MAX_INPUT || output_capacity != ORACLE_OUTPUT_CAPACITY) {
        return -1;
    }
    if (input_length != 0) {
        if (memchr(input, '\0', input_length) != NULL) {
            return -1;
        }
        memcpy(source, input, input_length);
    }
    source[input_length] = '\0';
    /* Apple's ps uses this compatibility symbol. Input is fixed/bounded, and
       the physical destination provides its documented 4*n+1 maximum. Keep the
       deprecation suppression local to this deliberate qualification oracle. */
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#endif
    length = strvis((char *)output, source, VIS_TAB | VIS_NL | VIS_NOSLASH);
#if defined(__clang__)
#pragma clang diagnostic pop
#endif
    if (length < 0 || (size_t)length > 4 * input_length ||
        (size_t)length >= output_capacity || output[length] != '\0') {
        return -1;
    }
    *output_length = (size_t)length;
    return 0;
}

/* Read intentionally unreaped zombie identity through actual SDK kinfo_proc
   fields. Live fixtures retain libproc; text-only equality and a cached live
   observation cannot substitute for four fresh identity acquisitions. */
int caws_comm_zombie_kinfo_identity(pid_t pid, uint32_t *observed_pid,
                                   uint32_t *parent, uint64_t *start_seconds,
                                   uint64_t *start_micros)
{
    struct kinfo_proc info = {0};
    size_t length = sizeof(info);
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    struct timeval start;
    pid_t observed_parent;

    if (pid <= 0 || observed_pid == NULL || parent == NULL ||
        start_seconds == NULL || start_micros == NULL) {
        return -1;
    }
    if (sysctl(mib, 4, &info, &length, NULL, 0) != 0 ||
        length != sizeof(info) || info.kp_proc.p_pid != pid ||
        info.kp_proc.p_stat != SZOMB) {
        return -1;
    }
    start = info.kp_proc.p_starttime;
    observed_parent = info.kp_eproc.e_ppid;
    if (observed_parent <= 0 || start.tv_sec <= 0 ||
        start.tv_usec < 0 || start.tv_usec >= 1000000) {
        return -1;
    }
    *observed_pid = (uint32_t)info.kp_proc.p_pid;
    *parent = (uint32_t)observed_parent;
    *start_seconds = (uint64_t)start.tv_sec;
    *start_micros = (uint64_t)start.tv_usec;
    return 0;
}
