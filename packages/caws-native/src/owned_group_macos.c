/* SDK-owned kinfo_proc ABI. A snapshot proves only exited group membership,
 * never signal acceptance or containment beyond the caller's private group.
 * The Rust caller brackets this query with WNOWAIT on its actual Child. */
#include <sys/types.h>
#include <sys/param.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

struct caws_group_observation {
    int32_t reason;
    int32_t query_errno;
    uint64_t bytes;
    uint64_t capacity;
    uint32_t members;
    uint32_t zombies;
    uint32_t leaders;
};

void caws_native_exited_group(pid_t pid, struct caws_group_observation *out)
{
    enum { MAX_MEMBERS = 4096 };
    struct kinfo_proc *members;
    size_t capacity = MAX_MEMBERS * sizeof(struct kinfo_proc);
    size_t length = capacity;
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PGRP, pid};
    uid_t real_uid = getuid(), effective_uid = geteuid();
    pid_t parent = getpid();
    if (out == NULL) return;
    *out = (struct caws_group_observation){0};
    out->capacity = capacity;
    if (pid <= 1 || pid == parent || pid == getpgrp() || real_uid != effective_uid) {
        out->reason = 1;
        return;
    }
    members = calloc(MAX_MEMBERS, sizeof(*members));
    if (members == NULL) { out->reason = 2; out->query_errno = ENOMEM; return; }
    /* One bounded-capacity fetch. ENOMEM/partial/full output is a refusal,
     * never a request to accept the truncated subset or use a ps fallback. */
    if (sysctl(mib, 4, members, &length, NULL, 0) != 0) {
        out->reason = 3;
        out->query_errno = errno;
        out->bytes = length;
        free(members);
        return;
    }
    out->bytes = length;
    if (length >= capacity || length % sizeof(*members) != 0) {
        out->reason = 4;
        free(members);
        return;
    }
    out->members = (uint32_t)(length / sizeof(*members));
    if (out->members == 0) out->reason = 5;
    for (uint32_t i = 0; i < out->members; ++i) {
        const struct kinfo_proc *member = &members[i];
        if (member->kp_proc.p_pid <= 1 || member->kp_eproc.e_pgid != pid) {
            out->reason = 6;
            break;
        }
        for (uint32_t j = 0; j < i; ++j) {
            if (members[j].kp_proc.p_pid == member->kp_proc.p_pid) {
                out->reason = 6;
                break;
            }
        }
        if (out->reason != 0) break;
        /* Credential changes or incomplete credential output are uncertain.
         * Refuse even root's permission exception rather than erase EPERM. */
        if (member->kp_eproc.e_pcred.p_ruid != real_uid ||
            member->kp_eproc.e_pcred.p_svuid != effective_uid ||
            member->kp_eproc.e_ucred.cr_uid != effective_uid) {
            out->reason = 7;
            break;
        }
        if (member->kp_proc.p_stat != SZOMB) { out->reason = 8; break; }
        ++out->zombies;
        if (member->kp_proc.p_pid == pid) {
            ++out->leaders;
            if (member->kp_eproc.e_ppid != parent) { out->reason = 9; break; }
        }
    }
    if (out->reason == 0 && out->leaders != 1) out->reason = 9;
    free(members);
}
