    local handler_execution_path
    case "$_rh_handler_index" in
__CAWS_IMAGE_HANDLER_CASES__
      *) return 2 ;;
    esac
