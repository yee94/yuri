package com.yee94.yuri.nsh;

import java.util.Map;

/** One live notification event, already carrying an admitted proof. */
public final class NotificationEvent {
    public final String eventID;
    public final String kind;
    public final NotificationTarget target;
    public final NotificationAdmission admission;

    private NotificationEvent(String eventID, String kind, NotificationTarget target, NotificationAdmission admission) {
        this.eventID = eventID;
        this.kind = kind;
        this.target = target;
        this.admission = admission;
    }

    public static NotificationEvent parse(Object input, String lease) throws NotificationFailure {
        Map<String, Object> value = NotificationJson.map(input);
        if (value == null || !lease.equals(value.get("lease")) || lease.isEmpty()) throw NotificationFailure.invalid();
        for (String key : value.keySet()) {
            if (!key.equals("lease") && !key.equals("eventID") && !key.equals("kind")
                    && !key.equals("target") && !key.equals("admission")) throw NotificationFailure.invalid();
        }
        Object eventID = value.get("eventID");
        Object kind = value.get("kind");
        if (!(eventID instanceof String) || !NotificationPolicy.eventIdentifier((String) eventID)) throw NotificationFailure.invalid();
        if (!(kind instanceof String) || !NotificationPolicy.KINDS.contains(kind)) throw NotificationFailure.invalid();
        NotificationTarget target = value.containsKey("target") && value.get("target") != null
                ? NotificationTarget.parse(value.get("target")) : null;
        NotificationAdmission admission = value.containsKey("admission") && value.get("admission") != null
                ? NotificationAdmission.parse(value.get("admission")) : null;
        if (admission != null && (!admission.eventID.equals(eventID) || !admission.kind.equals(kind)
                || !admission.target.equals(target))) throw NotificationFailure.invalid();
        return new NotificationEvent((String) eventID, (String) kind, target, admission);
    }
}
